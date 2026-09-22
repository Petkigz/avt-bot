/**
 * Betting strategy engine.
 *
 * Fixes over the original:
 *  - `calculateNextBet(lastResult)` now actually receives win/loss results
 *    (fed by BetManager), so the martingale progression works.
 *  - `averageMultiplierThreshold` falls back to a sane default instead of
 *    being `undefined` (which previously made Custom strategies never bet).
 *  - `shouldStopTrading()` is enforced by the GameMonitor every cycle.
 */
class BettingStrategy {
    constructor(config = {}) {
        this.name = config.name || 'CUSTOM';
        this.initialBet = config.initialBet ?? 1;
        this.currentBet = this.initialBet;
        this.maxBet = config.maxBet ?? this.initialBet;
        this.minBet = config.minBet ?? Math.min(1, this.initialBet);
        this.targetMultiplier = config.targetMultiplier ?? 1.5;
        this.stopLoss = config.stopLoss ?? Infinity;
        this.takeProfit = config.takeProfit ?? Infinity;
        this.martingaleMultiplier = config.martingaleMultiplier || 2;
        // Custom configs used to omit this field entirely -> comparisons with
        // `undefined` are always false -> the bot never bet. Fall back to the
        // target multiplier, which is a sensible default.
        this.averageMultiplierThreshold = config.averageMultiplierThreshold ?? this.targetMultiplier;
        // Hard circuit-breaker: stop trading after this many consecutive losses.
        this.maxConsecutiveLosses = config.maxConsecutiveLosses ?? 5;
        this.consecutiveLosses = 0;
        this.consecutiveWins = 0;
    }

    /**
     * Resets the stake back to the initial bet WITHOUT clearing the loss
     * counters — used when a bet in the progression cannot be funded, so a
     * broken chain restarts small instead of resuming at an escalated size.
     */
    resetProgression() {
        this.currentBet = this.initialBet;
    }

    /**
     * Apply the outcome of the last settled trade to the progression.
     */
    recordResult(lastResult) {
        if (!lastResult) return;
        if (lastResult.won) {
            this.consecutiveWins++;
            this.consecutiveLosses = 0;
            this.currentBet = this.initialBet; // reset after a win
        } else {
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            // Martingale: multiply after a loss, capped at maxBet
            this.currentBet = Math.min(this.currentBet * this.martingaleMultiplier, this.maxBet);
        }
    }

    /**
     * Returns the stake for the next bet.
     * When `lastResult` is provided it is applied to the progression first
     * and then consumed — calling again with null simply returns the
     * already-progressed amount (safe for retries).
     */
    calculateNextBet(lastResult = null) {
        if (lastResult) {
            this.recordResult(lastResult);
        }
        return this.getNextBetAmount();
    }

    getNextBetAmount() {
        return Math.max(this.minBet, Math.min(this.currentBet, this.maxBet));
    }

    /**
     * Risk circuit-breakers: stop-loss, take-profit and a hard cap of
     * 5 consecutive losses. Called by GameMonitor every cycle.
     */
    shouldStopTrading(stats) {
        if (!stats) return false;
        return (
            stats.totalLoss <= -this.stopLoss ||
            stats.totalProfit >= this.takeProfit ||
            this.consecutiveLosses >= this.maxConsecutiveLosses
        );
    }

    /**
     * Validates a user-supplied (custom) strategy config.
     */
    static validate(cfg) {
        const errors = [];
        const numericFields = [
            'initialBet', 'maxBet', 'minBet', 'targetMultiplier',
            'stopLoss', 'takeProfit', 'martingaleMultiplier', 'averageMultiplierThreshold'
        ];
        for (const field of numericFields) {
            const v = cfg[field];
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
                errors.push(`${field} must be a positive number`);
            }
        }
        if (errors.length === 0) {
            if (cfg.minBet > cfg.maxBet) errors.push('minBet cannot exceed maxBet');
            if (cfg.initialBet < cfg.minBet || cfg.initialBet > cfg.maxBet) {
                errors.push('initialBet must be between minBet and maxBet');
            }
            if (cfg.targetMultiplier < 1.01) errors.push('targetMultiplier must be at least 1.01');
            if (cfg.martingaleMultiplier < 1) errors.push('martingaleMultiplier must be at least 1');
        }
        if (cfg.maxConsecutiveLosses !== undefined &&
            (!Number.isInteger(cfg.maxConsecutiveLosses) || cfg.maxConsecutiveLosses < 1)) {
            errors.push('maxConsecutiveLosses must be an integer >= 1');
        }
        return { ok: errors.length === 0, errors };
    }
}

module.exports = BettingStrategy;
