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
        this._rawMinEntry = options.minEntryProbability ?? 0.55;
        this._rawMaxEntry = options.maxEntryProbability ?? 0.85;
        this.baseEntryProbability = this._rawMinEntry;
        this.maxEntryProbability = this._rawMaxEntry;
        this.applyTargetScaling();
        this.coldStreakLimit = options.coldStreakLimit ?? 3;
        this.coldRecoveryCount = options.coldRecoveryCount ?? 1;
        this.tightenStep = options.tightenStep ?? 0.02;
        this.loosenStep = options.loosenStep ?? 0.01;

        this.entryProbability = this.baseEntryProbability;
        this.recencyHalfLife = options.recencyHalfLife ?? 250; // rounds until a result counts half
        this.recentWindow = options.recentWindow ?? 100;      // window for recency stats + Wilson bound
        this.wilsonCushion = options.wilsonCushion ?? 0.05;   // uncertainty tolerance on the lower bound
        this.history = [];
        this.consecutiveCold = 0;
        this.consecutiveWarm = 0;
        this.paused = false;
        this.settledBets = { wins: 0, losses: 0 };
        this.file = options.file || null;
    }

    /**
     * Entry thresholds are entry-DISCIPLINE knobs calibrated at the 1.3x
     * design target. As absolute numbers they become structurally
     * unreachable on higher targets — P(crash ≥ 2x) ≈ 45%, so a flat 0.55
     * gate would silently disable every 2x strategy. Both bounds therefore
     * scale by 1.3/target: the same discipline distance relative to each
     * target's own break-even, and behavior is UNCHANGED at ≤1.3x.
     */
    applyTargetScaling() {
        const factor = Math.min(1, 1.3 / this.targetMultiplier);
        this.baseEntryProbability = this._rawMinEntry * factor;
        this.maxEntryProbability = this._rawMaxEntry * factor;
    }

    /**
     * Switch to a new target multiplier at runtime (dashboard strategy
     * switch). Rescales the entry bounds, re-bases the adaptive threshold,
     * and re-evaluates the loss-streak regime against the new target.
     * The round history itself is target-independent and is kept.
     */
    retarget(targetMultiplier) {
        if (!Number.isFinite(targetMultiplier) || targetMultiplier <= 1) return;
        if (targetMultiplier === this.targetMultiplier) return;
        this.targetMultiplier = targetMultiplier;
        this.applyTargetScaling();
        this.entryProbability = this.baseEntryProbability;
        this._recomputeTailStreak();
        logger.info(
            `Model retargeted to ${this.targetMultiplier}x ` +
            `(entry window ${this.baseEntryProbability.toFixed(2)}–${this.maxEntryProbability.toFixed(2)})`
        );
    }

    /** Tail-streak recompute shared by setHistory() and retarget(). */
    _recomputeTailStreak() {
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
        this._recomputeTailStreak();
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
                    'loss-streak guard pausing bets until a warm round appears'
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

    /**
     * Recency-weighted estimate: rounds decay exponentially with age
     * (half-life `recencyHalfLife`), so the model tracks the CURRENT feed
     * instead of averaging months of data equally.
     */
    weightedProbCrashAtLeast(x) {
        const n = this.history.length;
        if (n === 0) return null;
        const halfLife = Math.max(10, this.recencyHalfLife);
        let weightSum = 0;
        let hitWeight = 0;
        for (let i = 0; i < n; i++) {
            const age = n - 1 - i;
            const w = Math.pow(0.5, age / halfLife);
            weightSum += w;
            if (this.history[i] >= x) hitWeight += w;
        }
        return (hitWeight + 1) / (weightSum + 2);
    }

    /**
     * Uniform estimate over only the last `window` rounds.
     */
    recentProbCrashAtLeast(x, window = this.recentWindow) {
        const recent = this.history.slice(-window);
        if (recent.length === 0) return null;
        const hits = recent.reduce((acc, v) => acc + (v >= x ? 1 : 0), 0);
        return (hits + 1) / (recent.length + 2);
    }

    /**
     * Wilson score lower bound (z=1.96) over the recent window — the honest
     * "worst case given this little data" estimate. Small samples get wide
     * bounds, which the gate uses to refuse uncertain entries.
     */
    wilsonLower(x, window = this.recentWindow) {
        const recent = this.history.slice(-window);
        const n = recent.length;
        if (n === 0) return null;
        const p = recent.reduce((acc, v) => acc + (v >= x ? 1 : 0), 0) / n;
        const z = 1.96;
        const z2 = z * z;
        const denom = 1 + z2 / n;
        const center = p + z2 / (2 * n);
        const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
        return Math.max(0, (center - spread) / denom);
    }

    /**
     * Working confidence: blend of the whole-history estimate and the
     * recency-weighted one. Falls back to the plain estimate while history
     * is still shorter than the recent window.
     */
    blendedProbability(x) {
        const all = this.probCrashAtLeast(x);
        if (this.history.length < this.recentWindow) return all;
        const weighted = this.weightedProbCrashAtLeast(x);
        if (all === null || weighted === null) return all ?? weighted;
        return 0.5 * all + 0.5 * weighted;
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
    /** DESCRIPTIVE ONLY. This scans historical data for the target that
     *  would have looked best — a classic in-sample curve fit. Picking the
     *  max of ~40 tried values guarantees one looks good by chance. The
     *  result is shown on the dashboard as a curiosity metric and must
     *  NEVER drive bet targeting unless validated out-of-sample. */
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

    /** Streak-guard state. Named 'regime' historically, but this is a
     *  LOSS-STREAK GUARD, not a statistical regime detector: k low crashes
     *  in an independent stream are not evidence the distribution changed —
     *  it is a risk rule that pauses betting through bad runs. */
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
        const probability = this.blendedProbability(this.targetMultiplier);

        if (this.paused) {
            return {
                allowed: false,
                reason: `loss-streak guard: ${this.consecutiveCold} low crashes in a row (risk rule — not evidence the stream changed)`,
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
        // Uncertainty guard: with sparse/noisy recent data the Wilson lower
        // bound must still sit near the threshold — otherwise skip the round.
        const lower = this.wilsonLower(this.targetMultiplier);
        if (lower !== null && lower + this.wilsonCushion < this.entryProbability) {
            return {
                allowed: false,
                reason: `confidence floor ${lower.toFixed(2)} too uncertain (needs ≥ ${(this.entryProbability - this.wilsonCushion).toFixed(2)})`,
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
            blendedProbability: this.blendedProbability(this.targetMultiplier),
            recentProbability: this.recentProbCrashAtLeast(this.targetMultiplier),
            probabilityLowerBound: this.wilsonLower(this.targetMultiplier),
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
