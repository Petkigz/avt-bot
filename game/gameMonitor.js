const EventEmitter = require('events');
const BettingStrategy = require('./strategies');
const StatsTracker = require('./statsTracker');
const BetManager = require('./betManager');
const FrameHelper = require('../util/frameHelper');
const { parseBalance } = require('../util/balance');
const logger = require('../util/logger');

/**
 * Watches one game page and drives the betting loop.
 *
 * Round model (fixes the off-by-one crash attribution of the original):
 *  - The payouts strip (`BUBBLE_MULTIPLIER`) only changes when a round CRASHES.
 *  - When the newest bubble changes, the round that just ended crashed at the
 *    NEW value — settlement and history therefore use the fresh value.
 *  - A bet is only settled once it has been seen "armed" (the round it belongs
 *    to was observed in flight). This prevents a bet placed during the betting
 *    window from being charged to the previous round's crash.
 *
 * Safety:
 *  - Re-entrancy lock: a slow cycle can never overlap itself (no double bets).
 *  - After N consecutive failing cycles the page is reloaded (self-healing).
 *  - `strategy.shouldStopTrading()` is enforced every cycle.
 *
 * Events (for dashboard/database wiring):
 *  - roundStarted, roundEnded {crash, predicted, nextPrediction, history, stats}
 *  - tradingStopped, status
 */
class GameMonitor extends EventEmitter {
    constructor(page, config, strategyConfig) {
        super();
        this.page = page;
        this.config = config;
        // Each monitor gets its OWN strategy instance so the selected
        // strategy is actually the one used for betting and cashouts.
        this.strategy = strategyConfig instanceof BettingStrategy
            ? strategyConfig
            : new BettingStrategy(strategyConfig || config.BETTING_STRATEGIES.MODERATE);
        this.statsTracker = new StatsTracker();
        this.betManager = new BetManager(config, this.strategy, this.statsTracker);

        this.multiplierHistory = [];
        this.historySize = config.GAME.HISTORY_SIZE;
        this.lastBubble = null;      // newest confirmed crash value on the strip
        this.roundInFlight = false;
        this.tradingHalted = false;
        this.stopped = false;
        this.monitoring = false;     // re-entrancy lock
        this.consecutiveFailures = 0;
        this.timer = null;
        this.nextPrediction = null;  // prediction for the upcoming round

        this.betManager.onTrade = (trade) => this.emit('trade', trade);
    }

    startMonitoring() {
        if (this.timer) return;
        logger.info(`Starting game monitoring with ${this.strategy.name} strategy`);
        this.timer = setInterval(() => this.tick(), this.config.GAME.POLLING_INTERVAL);
        this.tick(); // first cycle immediately
    }

    stopMonitoring() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.stopped = true;
    }

    async tick() {
        if (this.stopped || this.monitoring) return;
        this.monitoring = true;
        try {
            if (this.page.isClosed()) {
                logger.warn('Game page closed — stopping monitor');
                this.stopMonitoring();
                return;
            }
            await this.monitorCycle();
            this.consecutiveFailures = 0;
        } catch (error) {
            this.consecutiveFailures++;
            logger.error(`Game monitoring error (${this.consecutiveFailures} consecutive): ${error.message}`);
            if (this.consecutiveFailures >= this.config.GAME.MAX_CONSECUTIVE_FAILURES) {
                await this.recover();
            }
        } finally {
            this.monitoring = false;
        }
    }

    async monitorCycle() {
        const sel = this.config.SELECTORS.GAME;
        const frameTimeout = Math.min(this.config.GAME.POLLING_INTERVAL * 2, 10000);
        const frame = await FrameHelper.waitForSelectorInFrames(this.page, sel.BUBBLE_MULTIPLIER, frameTimeout);

        const state = await this.readState(frame);
        if (!state) return;

        const latest = state.bubbles.length > 0 ? state.bubbles[0] : null;
        if (latest === null) {
            logger.debug('No crash bubbles rendered yet');
            return;
        }

        // ---- Round-end detection / baseline ----
        if (this.lastBubble === null) {
            this.lastBubble = latest;
            if (this.multiplierHistory.length === 0) {
                this.multiplierHistory = state.bubbles.slice(0, this.historySize);
                logger.info(`Seeded history from payouts strip: [${this.multiplierHistory.join(', ')}]`);
            }
            logger.info(`Baseline crash value: ${latest}x`);
        } else if (latest !== this.lastBubble) {
            this.onRoundEnded(latest, state);
            this.lastBubble = latest;
        }

        // ---- In-flight detection ----
        const inflight =
            (Number.isFinite(state.liveMultiplier) && state.liveMultiplier >= 1) ||
            (state.cashoutButton.exists && state.cashoutButton.visible);

        if (inflight && !this.roundInFlight) {
            this.roundInFlight = true;
            const bet = this.betManager.currentBet;
            if (bet && !bet.armed) {
                bet.armed = true;
                logger.debug('Active bet armed (round in flight)');
            }
            this.emit('roundStarted');
        } else if (!inflight) {
            this.roundInFlight = false;
        }

        // ---- Stale bet sweep (never leave an unsettled bet blocking the loop) ----
        const pending = this.betManager.currentBet;
        if (pending && !pending.armed && Date.now() - pending.timestamp > this.config.GAME.BET_STALENESS_MS) {
            logger.warn('Bet could not be confirmed as in-flight — booking conservatively as loss');
            this.betManager.recordLoss(null);
        }

        // ---- Cashout window ----
        if (this.betManager.isWaitingForResult && inflight && Number.isFinite(state.liveMultiplier)) {
            await this.betManager.checkCashout(frame, state.liveMultiplier);
        }

        // ---- Risk enforcement (stop-loss / take-profit / streak breaker) ----
        const stats = this.statsTracker.getStats();
        if (!this.tradingHalted && this.strategy.shouldStopTrading(stats)) {
            this.tradingHalted = true;
            logger.warn(
                `RISK LIMIT REACHED — betting stopped. ` +
                `netProfit=${stats.netProfit.toFixed(2)}, profit=${stats.totalProfit.toFixed(2)}, ` +
                `loss=${stats.totalLoss.toFixed(2)}, consecutiveLosses=${this.strategy.consecutiveLosses}`
            );
            this.emit('tradingStopped', stats);
        }

        // ---- Bet placement (betting window only, one bet per round) ----
        const balance = parseBalance(state.balanceText);
        const bettingWindow =
            !inflight &&
            state.betButton.exists &&
            state.betButton.visible &&
            !state.betButton.disabled &&
            state.betButton.text.includes('bet');

        if (
            bettingWindow &&
            !this.tradingHalted &&
            !this.betManager.isWaitingForResult &&
            this.multiplierHistory.length >= this.historySize
        ) {
            const avg = this.average(this.multiplierHistory);
            if (avg <= this.strategy.averageMultiplierThreshold) {
                logger.info(`Bet opportunity: avg ${avg.toFixed(2)}x <= threshold ${this.strategy.averageMultiplierThreshold}`);
                await this.betManager.placeBet(frame, balance);
            } else {
                logger.debug(`No bet: avg ${avg.toFixed(2)}x > threshold ${this.strategy.averageMultiplierThreshold}`);
            }
        }

        this.emit('status', {
            latestCrash: latest,
            inFlight: inflight,
            balance,
            stats: this.statsTracker.getStats(),
            history: [...this.multiplierHistory]
        });
    }

    /**
     * The newest bubble on the payouts strip changed -> the round that just
     * ended crashed at `crashValue` (the NEW value, not the previous one).
     */
    onRoundEnded(crashValue, state) {
        logger.info(`Round ended at ${crashValue}x`);
        this.roundInFlight = false;

        // Settle BEFORE updating history so the prediction compared against
        // `crashValue` is the one made before this round started.
        const predictionForThisRound = this.nextPrediction;
        const bet = this.betManager.currentBet;
        if (this.betManager.isWaitingForResult && bet && !bet.settled) {
            if (bet.armed) {
                // The round our bet was in just crashed -> we lost (a confirmed
                // cashout would already have settled it as a win).
                this.betManager.recordLoss(crashValue);
            } else {
                bet.unarmedRoundEnds++;
                if (bet.unarmedRoundEnds >= 2) {
                    logger.warn('Bet never observed in flight — booking conservatively as loss');
                    this.betManager.recordLoss(crashValue);
                } else {
                    logger.warn('Round ended before bet was armed — giving it one more round to confirm');
                }
            }
        }

        this.multiplierHistory.unshift(crashValue);
        if (this.multiplierHistory.length > this.historySize) {
            this.multiplierHistory.length = this.historySize;
        }
        this.nextPrediction = this.average(this.multiplierHistory);

        this.emit('roundEnded', {
            crash: crashValue,
            predicted: predictionForThisRound,
            nextPrediction: this.nextPrediction,
            history: [...this.multiplierHistory],
            stats: this.statsTracker.getStats(),
            balanceText: state ? state.balanceText : null
        });
    }

    /**
     * Reads all needed DOM state in ONE evaluate round-trip.
     */
    async readState(frame) {
        try {
            const sel = this.config.SELECTORS.GAME;
            return await frame.evaluate((s) => {
                const q = (selector) => document.querySelector(selector);
                const visible = (el) => {
                    if (!el) return false;
                    const box = el.getBoundingClientRect();
                    return box.width > 0 && box.height > 0;
                };
                const bubbles = Array.from(document.querySelectorAll(s.BUBBLE_MULTIPLIER))
                    .slice(0, 12)
                    .map((el) => parseFloat((el.textContent || '').trim().replace(/x/gi, '')))
                    .filter((v) => Number.isFinite(v) && v > 0);

                const betBtn = q(s.BET_BUTTON);
                const cashBtn = q(s.CASHOUT_BUTTON);
                const live = q(s.CASHOUT_MULTIPLIER);
                const balanceEl = q(s.BALANCE);

                return {
                    bubbles,
                    betButton: betBtn ? {
                        exists: true,
                        text: (betBtn.textContent || '').trim().toLowerCase(),
                        disabled: !!betBtn.disabled,
                        visible: visible(betBtn)
                    } : { exists: false, text: '', disabled: true, visible: false },
                    cashoutButton: cashBtn ? {
                        exists: true,
                        disabled: !!cashBtn.disabled,
                        visible: visible(cashBtn)
                    } : { exists: false, disabled: true, visible: false },
                    liveMultiplier: live ? parseFloat((live.textContent || '').replace(/x/gi, '')) : null,
                    balanceText: balanceEl ? balanceEl.textContent : null
                };
            }, sel);
        } catch (error) {
            logger.error(`Error reading game state: ${error.message}`);
            return null;
        }
    }

    /**
     * Self-healing: after repeated failures, reload the page and re-baseline.
     */
    async recover() {
        this.consecutiveFailures = 0;
        logger.warn('Too many consecutive monitoring failures — reloading page to recover');
        try {
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.NAVIGATION.TIMEOUT });
        } catch (error) {
            logger.error(`Page reload failed: ${error.message}`);
        }
        this.lastBubble = null; // re-baseline from the payouts strip
        this.roundInFlight = false;
    }

    average(values) {
        if (!values || values.length === 0) return Infinity;
        return values.reduce((acc, v) => acc + v, 0) / values.length;
    }
}

module.exports = GameMonitor;
