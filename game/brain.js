const logger = require('../util/logger');

/**
 * The Brain — the single decision core of the bot.
 *
 * BOTH the live monitor and the paper/simulation harness run through this
 * class, so what you test in simulation is exactly what runs for real.
 *
 * Confidence tiers (promotion/demotion):
 *   OBSERVING -> no bets; warm-up: study rounds, build history/patterns
 *   MICRO     -> micro-bets only (tiny fraction of bankroll)
 *   ARMED     -> strategy stakes, still capped by the bankroll policy
 *
 * Promotion requires evidence: enough studied rounds, then a sustained
 * hit-rate over settled decisions. Demotion is fast when performance sags.
 *
 * A bet only happens when ALL gates pass:
 *   betting window open, tier allows it, no cooldown, model confidence OK
 *   (with volatility penalty), pattern check OK, bankroll policy OK.
 */
class Brain {
    constructor({ config, strategy, predictor, patterns, bankroll, microOnly }) {
        this.config = config;
        this.strategy = strategy;
        this.predictor = predictor;       // may be null (model disabled)
        this.patterns = patterns;         // may be null (patterns disabled)
        this.bankroll = bankroll;
        // Strict safety profile: never promote beyond the MICRO tier.
        this.microOnly = microOnly ?? !!(config.MICRO_ONLY);

        this.tier = 'OBSERVING';
        this.pendingResult = null;   // outcome of the last settled trade
        this.stakeCache = null;      // stake computed from the last result
        this.recentDecisions = [];   // rolling window of settled bet outcomes
        this.lastDecision = null;    // for dashboard/CSV
        this.lastConfidence = null;
        this.lastPattern = null;
        this.decisionFeed = [];      // rolling feed for the live learning dashboard
        this._lastDecisionSig = null;
        this.mode = config.MODE && config.MODE.PAPER ? 'paper' : 'live';
    }

    // ------------------------------------------------------------------
    // Round lifecycle
    // ------------------------------------------------------------------
    onRoundEnded(crash) {
        if (this.predictor) this.predictor.addRound(crash);
        if (this.patterns) this.patterns.observe(crash);
        this.updateTier();
    }

    /**
     * Called when a bet settles. `meta` carries the confidence/pattern that
     * were in force when the bet was placed.
     */
    recordOutcome(trade, meta = {}) {
        const won = trade.won === true;
        if (this.predictor) this.predictor.recordOutcome(won);
        if (this.patterns && meta.pattern) this.patterns.recordUsageOutcome(meta.pattern, won);
        if (this.bankroll) this.bankroll.recordTrade(trade);

        this.pendingResult = { won };
        this.recentDecisions.push(won);
        if (this.recentDecisions.length > this.config.RISK.DECISION_WINDOW) {
            this.recentDecisions.shift();
        }
        this.updateTier();
    }

    hitRate() {
        if (this.recentDecisions.length === 0) return null;
        const wins = this.recentDecisions.filter(Boolean).length;
        return wins / this.recentDecisions.length;
    }

    // ------------------------------------------------------------------
    // Decision
    // ------------------------------------------------------------------
    /**
     * The one and only betting decision path.
     * Returns { shouldBet, stake, confidence, pattern, reasons[], tier }.
     */
    decide({ bettingWindow, balance = null, cooldownRounds = 0, halted = false }) {
        const reasons = [];
        const decision = {
            shouldBet: false, stake: 0, confidence: null,
            pattern: null, tier: this.tier, reasons, mode: this.mode
        };

        if (halted) { reasons.push('trading halted'); return this.finish(decision); }
        if (!bettingWindow) { reasons.push('no betting window'); return this.finish(decision); }
        if (cooldownRounds > 0) { reasons.push(`cooldown (${cooldownRounds} rounds left)`); return this.finish(decision); }

        // ---- Tier gate (warm-up is MANDATORY) ----
        this.updateTier();
        if (this.tier === 'OBSERVING') {
            const studied = this.predictor ? this.predictor.history.length : 0;
            reasons.push(`observing/warm-up (${studied}/${this.config.RISK.MIN_ROUNDS_OBSERVE} rounds studied)`);
            return this.finish(decision);
        }

        // ---- Model confidence gate (+ volatility risk adjustment) ----
        let confidence = null;
        if (this.predictor) {
            const gate = this.predictor.shouldAllowBet();
            if (!gate.allowed) {
                reasons.push(`model: ${gate.reason}`);
                return this.finish(decision);
            }
            confidence = gate.probability;

            // Volatility risk evaluation: wild recent rounds demand MORE confidence.
            const vol = this.predictor.volatility();
            const volPenalty = Number.isFinite(vol) && vol > this.config.RISK.HIGH_VOLATILITY_THRESHOLD
                ? this.config.RISK.VOLATILITY_CONFIDENCE_PENALTY : 0;
            const required = this.predictor.entryProbability + volPenalty;
            if (confidence !== null && confidence < required) {
                reasons.push(
                    `confidence ${confidence.toFixed(2)} < required ${required.toFixed(2)}` +
                    (volPenalty > 0 ? ' (volatility penalty)' : '')
                );
                return this.finish(decision);
            }
        }

        // ---- Pattern gate ----
        let pattern = null;
        if (this.patterns) {
            pattern = this.patterns.detect();
            if (pattern.found) {
                if (pattern.risky) {
                    reasons.push(`pattern "${pattern.pattern}" signals risk (P=${pattern.probability.toFixed(2)})`);
                    return this.finish(decision);
                }
                // Blend pattern evidence with the base probability (quality-weighted).
                if (confidence !== null) {
                    const w = 0.5 * pattern.quality;
                    confidence = confidence * (1 - w) + pattern.probability * w;
                } else {
                    confidence = pattern.probability;
                }
            } else if (confidence !== null) {
                confidence *= this.config.PATTERN.NO_PATTERN_PENALTY; // unconfirmed = slightly less trust
            }
        }

        // ---- Stake sizing: strategy progression -> bankroll policy ----
        if (this.pendingResult) {
            this.stakeCache = this.strategy.calculateNextBet(this.pendingResult);
            this.pendingResult = null;
        }
        const rawStake = this.stakeCache ?? this.strategy.getNextBetAmount();
        let stake = this.bankroll ? this.bankroll.approveStake(rawStake, this.tier) : rawStake;

        if (stake < this.strategy.minBet) {
            // Floor at the strategy minimum IF the bankroll policy still allows it.
            const capCheck = this.bankroll ? this.bankroll.approveStake(this.strategy.minBet, this.tier) : this.strategy.minBet;
            if (capCheck >= this.strategy.minBet) stake = this.strategy.minBet;
            else {
                reasons.push('bankroll too small for minimum stake');
                return this.finish(decision);
            }
        }

        // ---- Bankroll hard gate ----
        if (this.bankroll) {
            const ok = this.bankroll.canBet(stake, balance);
            if (!ok.allowed) {
                reasons.push(`bankroll: ${ok.reason}`);
                return this.finish(decision);
            }
        }
        if (Number.isFinite(balance) && balance < stake) {
            reasons.push(`insufficient balance (${balance} < ${stake})`);
            return this.finish(decision);
        }

        decision.shouldBet = true;
        decision.stake = stake;
        decision.confidence = confidence;
        decision.pattern = pattern && pattern.found ? pattern : null;
        reasons.push('all gates passed');
        return this.finish(decision);
    }

    finish(decision) {
        this.lastDecision = decision;
        this.lastConfidence = decision.confidence;
        this.lastPattern = decision.pattern;

        // Feed the dashboard only when the decision situation actually changes.
        const sig = `${decision.shouldBet}|${decision.reasons[0] || ''}`;
        if (sig !== this._lastDecisionSig) {
            this._lastDecisionSig = sig;
            this.decisionFeed.push({
                ts: Date.now(),
                bet: decision.shouldBet,
                stake: decision.stake,
                tier: this.tier,
                confidence: decision.confidence,
                reason: decision.reasons[0] || ''
            });
            if (this.decisionFeed.length > 12) this.decisionFeed.shift();
        }
        return decision;
    }

    // ------------------------------------------------------------------
    // Tier management
    // ------------------------------------------------------------------
    updateTier() {
        const risk = this.config.RISK;
        const studied = this.predictor ? this.predictor.history.length : 0;
        const paused = this.predictor ? this.predictor.paused : false;
        const decisions = this.recentDecisions.length;
        const hr = this.hitRate();

        if (this.tier === 'OBSERVING') {
            if (studied >= risk.MIN_ROUNDS_OBSERVE && !paused) {
                this.setTier('MICRO', `warm-up complete (${studied} rounds studied) — micro-betting enabled`);
            }
        } else if (this.tier === 'MICRO') {
            if (paused) {
                // cold regime: keep tier, the model gate blocks bets anyway
            } else if (this.microOnly) {
                // strict safety profile: never promote past micro-bets
            } else if (decisions >= risk.PROMOTION_MIN_DECISIONS && hr !== null && hr >= risk.PROMOTION_HIT_RATE) {
                this.setTier('ARMED', `sustained hit-rate ${(hr * 100).toFixed(1)}% over ${decisions} bets — full stakes enabled (bankroll-capped)`);
            }
        } else if (this.tier === 'ARMED') {
            if (this.microOnly) {
                this.setTier('MICRO', 'MICRO_ONLY safety profile enabled — capped at micro-bets');
            } else if (decisions >= risk.DECISION_WINDOW / 2 && hr !== null && hr <= risk.DEMOTION_HIT_RATE) {
                this.setTier('MICRO', `hit-rate dropped to ${(hr * 100).toFixed(1)}% — demoted back to micro-bets`);
            }
        }
    }

    setTier(tier, reason) {
        if (tier === this.tier) return;
        logger.info(`Confidence tier: ${this.tier} -> ${tier} (${reason})`);
        this.tier = tier;
        this.stakeCache = null;
        this.pendingResult = null;
    }

    // ------------------------------------------------------------------
    snapshot() {
        return {
            tier: this.tier,
            mode: this.mode,
            microOnly: this.microOnly,
            hitRate: this.hitRate(),
            recentDecisions: this.recentDecisions.length,
            lastConfidence: this.lastConfidence,
            lastReasons: this.lastDecision ? this.lastDecision.reasons : [],
            decisionFeed: [...this.decisionFeed],
            model: this.predictor ? this.predictor.snapshot() : null,
            patterns: this.patterns ? this.patterns.snapshot() : null,
            bankroll: this.bankroll ? this.bankroll.snapshot() : null
        };
    }
}

module.exports = Brain;
