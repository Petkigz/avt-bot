const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');

/**
 * Adaptive model layer — the bot's "brain".
 *
 * What it learns:
 *  - Empirical crash distribution: P(crash >= X) estimated from ALL stored
 *    history (Laplace-smoothed), so entry decisions are evidence-based.
 *  - Regime detection: after `coldStreakLimit` consecutive crashes below the
 *    target, betting PAUSES ("cold regime") until the strip warms up again.
 *    This is the main loss-avoidance mechanism.
 *  - Outcome feedback: every settled bet nudges the entry threshold —
 *    losses tighten it (bet less often), wins loosen it slightly. The
 *    adjustment is BOUNDED (base..max) so it can never run away.
 *
 * State persists to data/model.json; the raw history lives in HistoryStore.
 *
 * HONEST NOTE: Aviator rounds are produced by an RNG — no model can predict
 * the next crash. This module improves ENTRY DISCIPLINE and bankroll
 * protection from observed data; it does not remove the house edge.
 */
class Predictor {
    constructor(options = {}) {
        this.targetMultiplier = options.targetMultiplier ?? 1.5;
        this.minSampleSize = options.minSampleSize ?? 30;
        this.baseEntryProbability = options.minEntryProbability ?? 0.55;
        this.maxEntryProbability = options.maxEntryProbability ?? 0.85;
        this.coldStreakLimit = options.coldStreakLimit ?? 3;
        this.coldRecoveryCount = options.coldRecoveryCount ?? 1;
        this.tightenStep = options.tightenStep ?? 0.02;
        this.loosenStep = options.loosenStep ?? 0.01;

        this.entryProbability = this.baseEntryProbability;
        this.history = [];
        this.consecutiveCold = 0;
        this.consecutiveWarm = 0;
        this.paused = false;
        this.settledBets = { wins: 0, losses: 0 };
        this.file = options.file || null;
    }

    // ------------------------------------------------------------------
    // Persistence
    // ------------------------------------------------------------------
    static load(file, options = {}) {
        const predictor = new Predictor({ ...options, file });
        try {
            if (file && fs.existsSync(file)) {
                const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (Number.isFinite(saved.entryProbability)) {
                    predictor.entryProbability = Math.min(
                        Math.max(saved.entryProbability, predictor.baseEntryProbability),
                        predictor.maxEntryProbability
                    );
                }
                predictor.consecutiveCold = saved.consecutiveCold | 0;
                predictor.consecutiveWarm = saved.consecutiveWarm | 0;
                predictor.paused = !!saved.paused;
                if (saved.settledBets) {
                    predictor.settledBets = {
                        wins: saved.settledBets.wins | 0,
                        losses: saved.settledBets.losses | 0
                    };
                }
            }
        } catch (error) {
            logger.warn(`Could not load model state (${error.message}) — starting fresh`);
        }
        return predictor;
    }

    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify({
                entryProbability: this.entryProbability,
                consecutiveCold: this.consecutiveCold,
                consecutiveWarm: this.consecutiveWarm,
                paused: this.paused,
                settledBets: this.settledBets
            }, null, 2));
        } catch (error) {
            logger.warn(`Could not persist model state: ${error.message}`);
        }
    }

    /**
     * Feeds the full stored history into the model at startup.
     */
    setHistory(values) {
        this.history = [...values];
        // Recompute the tail streak so regime detection is accurate on load.
        this.consecutiveCold = 0;
        this.consecutiveWarm = 0;
        for (let i = this.history.length - 1; i >= 0; i--) {
            const cold = this.history[i] < this.targetMultiplier;
            if (cold) {
                if (this.consecutiveWarm > 0) break;
                this.consecutiveCold++;
            } else {
                if (this.consecutiveCold > 0) break;
                this.consecutiveWarm++;
            }
        }
        this.paused = this.consecutiveCold >= this.coldStreakLimit;
    }

    // ------------------------------------------------------------------
    // Learning
    // ------------------------------------------------------------------
    addRound(crash) {
        if (!Number.isFinite(crash) || crash <= 0) return;
        this.history.push(crash);
        if (this.history.length > 5000) this.history.shift();

        if (crash < this.targetMultiplier) {
            this.consecutiveCold++;
            this.consecutiveWarm = 0;
            if (!this.paused && this.consecutiveCold >= this.coldStreakLimit) {
                this.paused = true;
                logger.warn(
                    `Model: ${this.consecutiveCold} consecutive crashes below ${this.targetMultiplier}x — ` +
                    'pausing bets until the strip warms up (cold regime)'
                );
            }
        } else {
            this.consecutiveWarm++;
            this.consecutiveCold = 0;
            if (this.paused && this.consecutiveWarm >= this.coldRecoveryCount) {
                this.paused = false;
                logger.info('Model: strip warmed up — bets allowed again');
            }
        }
        this.save();
    }

    /**
     * Outcome feedback after every settled bet (bounded adjustment).
     */
    recordOutcome(won) {
        if (won) {
            this.settledBets.wins++;
            this.entryProbability = Math.max(
                this.baseEntryProbability,
                this.entryProbability - this.loosenStep
            );
        } else {
            this.settledBets.losses++;
            this.entryProbability = Math.min(
                this.maxEntryProbability,
                this.entryProbability + this.tightenStep
            );
        }
        this.save();
    }

    // ------------------------------------------------------------------
    // Estimation
    // ------------------------------------------------------------------
    probCrashAtLeast(x) {
        const n = this.history.length;
        if (n === 0) return null;
        const hits = this.history.reduce((acc, v) => acc + (v >= x ? 1 : 0), 0);
        return (hits + 1) / (n + 2); // Laplace smoothing
    }

    average() {
        if (this.history.length === 0) return null;
        return this.history.reduce((a, v) => a + v, 0) / this.history.length;
    }

    volatility() {
        const n = this.history.length;
        if (n < 2) return null;
        const mean = this.average();
        const variance = this.history.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
        return Math.sqrt(variance);
    }

    /**
     * Informational: the multiplier that historically maximized p(x)*x - 1.
     */
    bestTarget() {
        if (this.history.length < this.minSampleSize) return null;
        let best = null;
        for (let x = 1.1; x <= 5.0; x += 0.1) {
            const p = this.probCrashAtLeast(x);
            if (p === null) continue;
            const ev = p * x - 1;
            if (!best || ev > best.ev) best = { target: Math.round(x * 10) / 10, ev, probability: p };
        }
        return best;
    }

    regime() {
        if (this.paused) return 'cold';
        if (this.consecutiveCold >= Math.max(1, this.coldStreakLimit - 1)) return 'cooling';
        if (this.consecutiveWarm >= 2) return 'hot';
        return 'neutral';
    }

    // ------------------------------------------------------------------
    // Decision gate
    // ------------------------------------------------------------------
    shouldAllowBet() {
        const n = this.history.length;
        const probability = this.probCrashAtLeast(this.targetMultiplier);

        if (this.paused) {
            return {
                allowed: false,
                reason: `cold regime (${this.consecutiveCold} low crashes in a row)`,
                probability,
                regime: this.regime()
            };
        }
        if (n < this.minSampleSize) {
            return {
                allowed: true,
                warmingUp: true,
                probability,
                regime: this.regime(),
                reason: `warming up (${n}/${this.minSampleSize} rounds studied)`
            };
        }
        if (probability === null || probability < this.entryProbability) {
            return {
                allowed: false,
                reason: `confidence ${(probability ?? 0).toFixed(2)} < required ${this.entryProbability.toFixed(2)}`,
                probability,
                regime: this.regime()
            };
        }
        return { allowed: true, probability, regime: this.regime(), reason: 'model OK' };
    }

    snapshot() {
        return {
            roundsStudied: this.history.length,
            probability: this.probCrashAtLeast(this.targetMultiplier),
            entryProbability: this.entryProbability,
            regime: this.regime(),
            paused: this.paused,
            consecutiveCold: this.consecutiveCold,
            consecutiveWarm: this.consecutiveWarm,
            average: this.average(),
            volatility: this.volatility(),
            bestTarget: this.bestTarget(),
            settledBets: { ...this.settledBets }
        };
    }
}

module.exports = Predictor;
