const logger = require('../util/logger');
const { extractFeatures, FEATURE_VERSION } = require('./features');
const { lookElsewherePenalty } = require('./modelLayer');

/** Wilson score lower bound for a binomial proportion (95%). The honest way
 *  to say "this pattern's live win rate beats X": the lower edge of the
 *  uncertainty interval must exceed it, not just the point estimate. */
function wilsonLower(wins, n, z = 1.96) {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const p = Math.min(1, Math.max(0, wins / n));
    const z2 = z * z;
    const center = p + z2 / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (center - spread) / (1 + z2 / n));
}

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
    constructor({ config, strategy, predictor, patterns, bankroll, microOnly, signal, recalibrator, featureModel, modelVerdict }) {
        this.config = config;
        this.strategy = strategy;
        this.predictor = predictor;       // may be null (model disabled)
        this.patterns = patterns;         // may be null (patterns disabled)
        this.bankroll = bankroll;
        // Phase-3 deployed feature model: { predict(features) -> P(next >= target) }.
        // Loaded ONLY when scripts/train-model.js writes a DEPLOY verdict, so its
        // mere presence means the model beat the base-rate null out-of-sample with
        // positive economic value. When absent (NO_SIGNAL / INSUFFICIENT_DATA) the
        // Brain stays discipline-only — the model is ALLOWED to say NO SIGNAL.
        this.featureModel = featureModel || null;
        // The raw training verdict (display-only audit trail for the dashboard).
        this.modelVerdict = modelVerdict || null;
        // Adaptive probability self-repair: studies how the engine's own
        // predictions settled and corrects systematic mis-calibration.
        // Pass-through until enough predictions have settled.
        this.recalibrator = recalibrator || null;
        // Walk-forward validation hookup: { policy, getVerdict() }. Policy
        // 'strict' refuses bets until this site has a positive OUT-OF-SAMPLE
        // signal verdict; 'advisory' (default) only reports it.
        this.signal = signal || null;
        // Strict safety profile: never promote beyond the MICRO tier.
        this.microOnly = microOnly ?? !!(config.MICRO_ONLY);

        this.tier = 'OBSERVING';
        this.paused = false;         // user toggle from the dashboard (UI kill-switch)
        this.pendingResult = null;   // outcome of the last settled trade
        this.stakeCache = null;      // stake computed from the last result
        this.pendingTarget = null;   // target of the armed bet (ADAPTIVE regime guard)
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
        // Feed the regime guard the target that was actually bet (ADAPTIVE
        // picks a different one each round); fall back to the nominal target.
        const betTarget = this.pendingTarget ?? (this.strategy ? this.strategy.targetMultiplier : null);
        this.pendingTarget = null;
        if (this.predictor) this.predictor.addRound(crash, betTarget);
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

    /**
     * Hot-swap the strategy (dashboard strategy switch). The model and the
     * pattern miner are TARGET-specific — a predictor tuned for 1.3x must be
     * retargeted when the user switches to a 2x strategy, or the confidence
     * gate measures the wrong event. Entry bounds rescale with the target so
     * every preset stays operable (see Predictor.applyTargetScaling).
     */
    setStrategy(strategy) {
        this.strategy = strategy;
        this.stakeCache = null;
        this.pendingResult = null;
        if (this.predictor && Number.isFinite(strategy.targetMultiplier)) {
            this.predictor.retarget(strategy.targetMultiplier);
        }
        if (this.patterns && Number.isFinite(strategy.targetMultiplier)) {
            this.patterns.targetMultiplier = strategy.targetMultiplier;
        }
        // Target-safe model versioning (review #8): a deployed model was
        // trained and validated for ONE target. If the strategy moves to a
        // different target, the model must NOT be reused — its probabilities
        // would be meaningless for the new break-even. The Brain falls back to
        // the statistical gate until "npm run train:model" re-validates.
        if (this.featureModel && this.featureModel.meta &&
            Number.isFinite(strategy.targetMultiplier) &&
            Number.isFinite(this.featureModel.meta.target) &&
            Math.abs(this.featureModel.meta.target - strategy.targetMultiplier) > 1e-6) {
            logger.info(`Feature model was trained for ${this.featureModel.meta.target}x but strategy now targets ${strategy.targetMultiplier}x — model parked, statistical gate in force (run "npm run train:model" to re-validate)`);
        }
    }

    /**
     * The deployed feature model IF AND ONLY IF it is valid for the current
     * target and feature version. A model trained for 1.3x must never answer
     * a 2.0x question, and a model trained on an old feature schema must
     * never read new features. Returns null otherwise — the caller then falls
     * back to the statistical gate (discipline-only for that target).
     */
    featureModelFor(target) {
        const fm = this.featureModel;
        if (!fm || !fm.meta) return null;
        if (!Number.isFinite(target) || !Number.isFinite(fm.meta.target)) return null;
        if (Math.abs(fm.meta.target - target) > 1e-6) return null;
        if (Number.isFinite(fm.meta.featureVersion) && fm.meta.featureVersion !== FEATURE_VERSION) return null;
        return fm;
    }

    /**
     * Extra entry confidence demanded while the stream is unusually wild.
     * Measured RELATIVE to the stream's own long-run volatility — crash
     * series carry huge absolute std-dev (heavy tails) at ALL times, so an
     * absolute threshold would be permanently "on" and silently lock the
     * entry gate. Only a genuine recent spike (recent window clearly wilder
     * than the stream's norm) tightens the gate. Returns 0 in normal times.
     */
    volatilityPenalty() {
        if (!this.predictor) return 0;
        const recentVol = this.predictor.recentVolatility();
        const longVol = this.predictor.volatility();
        const spike = Number.isFinite(recentVol) && Number.isFinite(longVol) && longVol > 0 &&
            recentVol > longVol * this.config.RISK.VOLATILITY_SPIKE_RATIO;
        return spike ? this.config.RISK.VOLATILITY_CONFIDENCE_PENALTY : 0;
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
            pattern: null, tier: this.tier, reasons, mode: this.mode,
            targetMultiplier: this.strategy ? this.strategy.targetMultiplier : null
        };

        if (halted) { reasons.push('trading halted'); return this.finish(decision); }
        if (this.paused) { reasons.push('paused by user (dashboard)'); return this.finish(decision); }
        if (!bettingWindow) { reasons.push('no betting window'); return this.finish(decision); }
        if (cooldownRounds > 0) { reasons.push(`cooldown (${cooldownRounds} rounds left)`); return this.finish(decision); }

        // ---- Tier gate (warm-up is MANDATORY) ----
        this.updateTier();
        if (this.tier === 'OBSERVING') {
            const studied = this.predictor ? this.predictor.history.length : 0;
            reasons.push(`observing/warm-up (${studied}/${this.config.RISK.MIN_ROUNDS_OBSERVE} rounds studied)`);
            return this.finish(decision);
        }

        // ---- Signal-policy gate (walk-forward verdict controls the loop) ----
        // In STRICT mode a site may only bet after its own out-of-sample
        // validation has demonstrated predictive signal. This is the "I don't
        // know -> don't bet" switch: absence of evidence blocks betting.
        // A signal must also be CONFIRMED — significant over the full OOS
        // span AND still lifting on the newest holdout third. Detected-but-
        // unconfirmed signals are treated as false-positive risk and block.
        if (this.signal && String(this.signal.policy || '').toLowerCase() === 'strict') {
            const v = this.signal.getVerdict ? this.signal.getVerdict() : null;
            if (!v || !v.signalDetected || !v.signalConfirmed) {
                reasons.push(
                    !v || !v.signalDetected
                        ? 'signal policy STRICT: no validated out-of-sample signal for this site yet (run walk-forward validation)'
                        : 'signal policy STRICT: signal candidate UNCONFIRMED on the fresh holdout — treating as false-positive risk'
                );
                return this.finish(decision);
            }
            // A signal can be statistically real yet still LOSE money if its
            // hit rate sits below the break-even probability (1/target).
            // Strict mode requires the edge to clear break-even too.
            if (v.signalEconomical === false) {
                reasons.push('signal policy STRICT: signal confirmed but below break-even probability — betting it still loses money');
                return this.finish(decision);
            }
        }

        // ---- Model confidence gate (+ volatility risk adjustment) ----
        let confidence = null;
        const adaptive = !!(this.strategy && this.strategy.adaptiveTarget) && this.predictor;
        let adaptiveHitProb = null; // raw model P(hit) of the drawn target — sizes the stake
        if (adaptive) {
            // ADAPTIVE mode: the model picks this round's target from its
            // live distribution read instead of betting a fixed multiplier.
            // Confidence and target are COUPLED here — a 30x target
            // legitimately carries a ~3% hit probability — so a fixed
            // confidence threshold cannot apply. Discipline comes from the
            // loss-streak guard (checked inside the pick), the tier gate and
            // the bankroll policy. HONEST NOTE: this rides the model's
            // DISTRIBUTION read, which shifts slowly; it does not predict
            // individual rounds (walk-forward found no per-round signal).
            if (this.predictor.paused) {
                reasons.push(
                    `model: loss-streak guard: ${this.predictor.consecutiveCold} low crashes in a row (risk rule — not evidence the stream changed)`
                );
                return this.finish(decision);
            }
            const pick = this.predictor.adaptiveTarget({
                minTarget: this.strategy.adaptiveMin,
                maxTarget: this.strategy.adaptiveMax,
                minProb: this.config.RISK.ADAPTIVE_PROB_MIN,
                maxProb: this.config.RISK.ADAPTIVE_PROB_MAX
            });
            decision.targetMultiplier = pick.target;
            adaptiveHitProb = pick.confidence;
            confidence = pick.confidence;
            if (this.recalibrator && confidence !== null) {
                confidence = this.recalibrator.adjust(confidence);
            }
            decision.reasons.push(
                `adaptive target ${pick.target}x (model P(hit) ≈ ${(confidence ?? 0).toFixed(2)})`
            );
        } else if (this.predictor) {
            const gate = this.predictor.shouldAllowBet();
            // The loss-streak guard is a RISK rule — it applies no matter which
            // model supplies the confidence.
            if (!gate.allowed && this.predictor.paused) {
                reasons.push(`model: ${gate.reason}`);
                return this.finish(decision);
            }

            // ---- Confidence source ---------------------------------------
            // Phase-3 feature model: when a DEPLOY verdict loaded one, its
            // CALIBRATED probability REPLACES the raw estimator (it beat the
            // best simple null out-of-sample with positive EV — that is what
            // deployment means). The model is only used if it matches the
            // CURRENT target and feature version (target-safe versioning);
            // otherwise the Brain falls back to the statistical gate. With a
            // NO_SIGNAL verdict nothing is loaded and the Brain stays
            // discipline-only: the model's "NO SIGNAL" is honored.
            let fromFeatureModel = false;
            const activeModel = this.featureModelFor(this.strategy.targetMultiplier);
            if (activeModel) {
                const feats = extractFeatures(this.predictor.history, this.strategy.targetMultiplier);
                const fmProb = activeModel.predict(feats);
                if (Number.isFinite(fmProb)) {
                    confidence = fmProb;
                    fromFeatureModel = true;
                    decision.modelTarget = activeModel.meta.target;
                }
            }
            if (!fromFeatureModel) {
                if (!gate.allowed) {
                    reasons.push(`model: ${gate.reason}`);
                    return this.finish(decision);
                }
                confidence = gate.probability;

                // Intelligence upgrade #1: recalibrated confidence — the engine's
                // own settled track record corrects systematic over/under-
                // confidence before it is compared against the entry threshold.
                // (Applied to the estimator only — the deployed feature model
                // ships its own Platt calibrator fitted before the untouched
                // holdout, so re-correcting it here would double-adjust.)
                if (this.recalibrator && confidence !== null) {
                    confidence = this.recalibrator.adjust(confidence);
                }
            }

            // Volatility risk evaluation: wild recent rounds demand MORE confidence.
            const volPenalty = this.volatilityPenalty();
            const required = this.predictor.entryProbability + volPenalty;
            if (confidence !== null && confidence < required) {
                reasons.push(
                    `confidence ${confidence.toFixed(2)} < required ${required.toFixed(2)}` +
                    (volPenalty > 0 ? ' (volatility penalty)' : '') +
                    (fromFeatureModel ? ' (feature model)' : '')
                );
                return this.finish(decision);
            }
            if (fromFeatureModel) decision.featureModel = true;
        }

        // ---- Pattern gate (freeze → test → promote → statistical evidence) ----
        // Patterns are mined in-sample, and with 3^k possible sequences a
        // random stream constantly produces impressive-looking noise. So a
        // mined pattern starts as a CANDIDATE: it is frozen and cannot move
        // confidence at all until it has survived PATTERN_MIN_LIVE_USES
        // UNSEEN future rounds (its live track record). After promotion, its
        // betting weight additionally requires STATISTICAL evidence that the
        // live win rate BEATS the stream's base rate (Wilson lower bound):
        // at a 1.3x target ~75% of rounds win ANYWAY, so "wins often" proves
        // nothing — only beating the base rate does. A pattern whose live
        // win rate ends up below the base rate becomes a RISK block.
        let pattern = null;
        if (this.patterns) {
            pattern = this.patterns.detect();
            // ADAPTIVE mode: patterns keep mining on the nominal anchor, but
            // they cannot move confidence or veto a VARIABLE target — their
            // stats describe a different event. Still surfaced on decisions.
            if (pattern.found && !adaptive) {
                const minUses = this.config.PATTERN.MIN_LIVE_USES;
                const used = pattern.used || 0;
                const promoted = used >= minUses;
                const maturity = promoted ? Math.min(1, used / (2 * minUses)) : 0;
                const baseRate = this.predictor
                    ? this.predictor.probCrashAtLeast(this.strategy.targetMultiplier) : null;
                const maturedUnderperformer = promoted && maturity >= 1 &&
                    Number.isFinite(pattern.liveWinRate) &&
                    pattern.liveWinRate < (Number.isFinite(baseRate) ? baseRate : 0.5);
                if (pattern.risky || maturedUnderperformer) {
                    reasons.push(
                        `pattern "${pattern.pattern}" signals risk (P=${pattern.probability.toFixed(2)}` +
                        (maturedUnderperformer
                            ? `, live win rate ${(pattern.liveWinRate * 100).toFixed(0)}% after ${used} uses is below the ${(baseRate * 100).toFixed(0)}% base rate`
                            : '') + ')'
                    );
                    return this.finish(decision);
                }
                // Statistical evidence factor: how confidently does the live
                // record beat the base rate? Zero until the Wilson lower
                // bound of (liveWins, used) exceeds the base rate, then ramps
                // to 1 over a 5-point gap. On a fair stream this stays 0 —
                // exactly what the evidence says.
                //
                // MULTIPLE-TESTING CORRECTION (look-elsewhere): the miner
                // searches a huge space of candidate sequences (3^k possible
                // patterns), so SOME pattern always looks good by chance. The
                // lower bound must therefore clear the base rate by a margin
                // that grows with the size of the searched space and shrinks
                // only as live evidence accumulates.
                let evidence = 1;
                if (promoted && Number.isFinite(baseRate) && baseRate > 0 && used > 0) {
                    const searched = this.patterns && this.patterns.patterns
                        ? Math.max(2, this.patterns.patterns.size) : 2;
                    const penalty = lookElsewherePenalty(used, searched);
                    const lower = wilsonLower(pattern.liveWins || 0, used) - penalty;
                    evidence = Math.max(0, Math.min(1, (lower - baseRate) / 0.05));
                }
                // Blend pattern evidence with the base probability — but ONLY
                // in proportion to proven live record x statistical evidence.
                const w = 0.5 * pattern.quality * maturity * evidence;
                if (confidence !== null) {
                    confidence = confidence * (1 - w) + pattern.probability * w;
                } else {
                    // No model: an unproven pattern must not fake confidence.
                    // Blend against a neutral 0.5 prior with the SAME weight,
                    // so only promoted, evidence-backed patterns move the needle.
                    confidence = 0.5 * (1 - w) + pattern.probability * w;
                }
            } else if (!adaptive && confidence !== null) {
                confidence *= this.config.PATTERN.NO_PATTERN_PENALTY; // unconfirmed = slightly less trust
            }
        }

        // ---- Stake sizing: strategy progression -> bankroll policy ----
        if (this.bankroll && !this.bankroll.hasReference()) {
            reasons.push('no verified bankroll yet — waiting for the site balance to be read (required before any real bet)');
            return this.finish(decision);
        }
        if (this.pendingResult) {
            this.stakeCache = this.strategy.calculateNextBet(this.pendingResult);
            this.pendingResult = null;
        }
        const rawStake = this.stakeCache ?? this.strategy.getNextBetAmount();
        let stake = this.bankroll ? this.bankroll.approveStake(rawStake, this.tier) : rawStake;

        // Confidence-proportional sizing: marginal-confidence entries bet
        // smaller, strong-confidence entries bet full — never below 50% of
        // the approved stake. Only applies when a confidence exists.
        // (Adaptive mode has its own rule below: its confidence is the hit
        // probability of a VARIABLE target, not comparable against the fixed
        // entry window.)
        if (!adaptive && this.config.RISK.CONFIDENCE_SCALING && this.predictor && Number.isFinite(confidence)) {
            const base = this.predictor.baseEntryProbability;
            const span = Math.max(0.01, this.predictor.maxEntryProbability - base);
            const f = Math.min(1, Math.max(0, (confidence - base) / span));
            stake = Math.round(stake * (0.5 + 0.5 * f) * 100) / 100;
        }

        // ADAPTIVE stake sizing: the stake follows the model's own read of
        // THIS bet — safe picks (small target, high P(hit)) stake near the
        // approved amount, longshot picks (big target, low P(hit)) stake a
        // reduced share, never below ADAPTIVE_MIN_STAKE_FRACTION of it. Uses
        // the RAW hit probability: the recalibrator is trained on fixed-target
        // predictions and would distort the variable-target scale.
        if (adaptive && Number.isFinite(adaptiveHitProb)) {
            const pMin = this.config.RISK.ADAPTIVE_PROB_MIN;
            const pMax = this.config.RISK.ADAPTIVE_PROB_MAX;
            const norm = Math.min(1, Math.max(0, (adaptiveHitProb - pMin) / Math.max(0.01, pMax - pMin)));
            const minFrac = Math.min(1, Math.max(0, this.config.RISK.ADAPTIVE_MIN_STAKE_FRACTION));
            const frac = minFrac + (1 - minFrac) * norm;
            stake = Math.round(stake * frac * 100) / 100;
        }

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
        // Remember the target actually bet so the regime guard judges the
        // next round against IT (matters for ADAPTIVE's variable targets).
        this.pendingTarget = decision.shouldBet ? decision.targetMultiplier : null;

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
            bankroll: this.bankroll ? this.bankroll.snapshot() : null,
            recalibration: this.recalibrator ? this.recalibrator.snapshot() : null,
            signal: this.signal ? {
                policy: this.signal.policy || 'advisory',
                verdict: (() => {
                    try {
                        const v = this.signal.getVerdict ? this.signal.getVerdict() : null;
                        return v ? {
                            signalDetected: !!v.signalDetected, rounds: v.rounds,
                            target: v.target, ts: v.ts, text: v.verdict
                        } : null;
                    } catch (error) { return null; }
                })()
            } : null,
            // Phase-3 feature model: deployed (drives entries) or the verdict
            // that keeps the engine discipline-only. NO SIGNAL is visible here,
            // as are target-mismatch and staleness parking.
            featureModel: {
                deployed: !!this.featureModel,
                matched: !!(this.featureModel && this.featureModelFor(
                    this.strategy ? this.strategy.targetMultiplier : NaN)),
                modelTarget: this.featureModel && this.featureModel.meta
                    ? this.featureModel.meta.target : null,
                verdict: this.modelVerdict ? {
                    verdict: this.modelVerdict.verdict,
                    reason: this.modelVerdict.reason || '',
                    target: this.modelVerdict.target,
                    brierSkill: this.modelVerdict.brierSkill,
                    entryHitRate: this.modelVerdict.entryHitRate,
                    evPerBet: this.modelVerdict.evPerBet,
                    n: this.modelVerdict.n,
                    stale: !!this.modelVerdict.stale,
                    ts: this.modelVerdict.ts
                } : null
            }
        };
    }
}

module.exports = Brain;
