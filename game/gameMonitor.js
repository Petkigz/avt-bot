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
 * Round detection (multi-signal, hardened):
 *  - Primary: the payouts strip (`BUBBLE_MULTIPLIER`) only changes when a
 *    round CRASHES; the newest bubble IS that round's crash value.
 *  - Jitter guard: changes arriving < MIN_ROUND_GAP_MS after the previous
 *    accepted round end are deferred one cycle.
 *  - Flight-end fallback: if the flight visibly ends but the bubble never
 *    updates, the round is settled after FLIGHT_END_GRACE_MS so the loop
 *    can never stall.
 *  - Every accepted round end increments `roundId` for audit trails.
 *
 * Decision layers (ALL must agree before a bet):
 *  1. betting window open (button enabled, no round in flight)
 *  2. not halted, not in cooldown, no open bet
 *  3. strategy gate: recent average <= averageMultiplierThreshold
 *  4. model gate: predictor confidence / regime (unless warming up)
 *  5. balance >= stake + reserve
 *
 * Site-state recovery ladder (on repeated selector failures):
 *  level 1 -> reload the page and re-baseline
 *  level 2 -> emit 'needsRenavigation' (index.js navigates to GAME_URL)
 *  level 3 -> HALT trading permanently (monitoring continues); never bet blind
 *
 * Events: roundStarted, roundEnded, trade, tradingStopped, status,
 *         needsRenavigation
 */
class GameMonitor extends EventEmitter {
    constructor(page, config, strategyConfig, deps = {}) {
        super();
        this.page = page;
        this.config = config;
        this.predictor = deps.predictor || null;
        this.historyStore = deps.historyStore || null;

        // Each monitor gets its OWN strategy instance so the selected
        // strategy is actually the one used for betting and cashouts.
        this.strategy = strategyConfig instanceof BettingStrategy
            ? strategyConfig
            : new BettingStrategy(strategyConfig || config.BETTING_STRATEGIES.MODERATE);
        this.statsTracker = new StatsTracker();
        this.betManager = new BetManager(config, this.strategy, this.statsTracker);

        this.multiplierHistory = [];
        this.historySize = config.GAME.HISTORY_SIZE;
        this.lastBubble = null;
        this.lastRoundEndedAt = null;
        this.roundId = 0;
        this.roundInFlight = false;
        this.flightEndedAt = null;   // set when flight ends before the bubble updates
        this.tradingHalted = false;
        this.haltReason = null;
        this.cooldownRounds = 0;
        this.stopped = false;
        this.monitoring = false;     // re-entrancy lock
        this.consecutiveFailures = 0;
        this.recoveryLevel = 0;
        this.missingButtonCycles = 0;
        this.sessionWarned = false;
        this.attachedUrl = null;
        this.timer = null;
        this.nextPrediction = null;

        this.betManager.onTrade = (trade) => {
            if (this.predictor) this.predictor.recordOutcome(trade.won === true);
            this.emit('trade', trade);
        };
        // A progression reset means the chain broke — cool down before
        // re-entering so we don't immediately re-bet into the same situation.
        this.betManager.onProgressionReset = () => {
            this.enterCooldown(this.config.GAME.RESET_COOLDOWN_ROUNDS, 'progression reset (unfunded bet)');
        };
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
            this.recoveryLevel = 0; // healthy again — reset the ladder
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
        if (!this.attachedUrl) this.attachedUrl = this.page.url();

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
                logger.info(`Seeded session history from payouts strip: [${this.multiplierHistory.join(', ')}]`);
            }
            logger.info(`Baseline crash value: ${latest}x`);
        } else if (latest !== this.lastBubble) {
            this.detectRoundEnd(latest, state);
        }

        // ---- Selector-drift alarm (fail LOUDLY, not silently) ----
        if (state.betButton.exists) {
            this.missingButtonCycles = 0;
        } else {
            this.missingButtonCycles++;
            if (this.missingButtonCycles === 20 || this.missingButtonCycles % 50 === 0) {
                logger.error(
                    `Bet button selector has not matched for ${this.missingButtonCycles} cycles — ` +
                    'the page layout may have changed (check SELECTORS.GAME.BET_BUTTON)'
                );
            }
        }

        // ---- In-flight detection + flight-end tracking ----
        const inflight =
            (Number.isFinite(state.liveMultiplier) && state.liveMultiplier >= 1) ||
            (state.cashoutButton.exists && state.cashoutButton.visible);

        if (inflight && !this.roundInFlight) {
            this.roundInFlight = true;
            this.flightEndedAt = null;
            const bet = this.betManager.currentBet;
            if (bet && !bet.armed) {
                bet.armed = true;
                logger.debug(`Active bet armed for round #${this.roundId + 1} (flight started)`);
            }
            this.emit('roundStarted', { roundId: this.roundId + 1 });
        } else if (!inflight && this.roundInFlight) {
            this.roundInFlight = false;
            // Flight ended but the crash bubble hasn't updated yet — start
            // the grace timer so a missed bubble can never stall the loop.
            this.flightEndedAt = Date.now();
        }

        // ---- Stale/stuck bet sweep ----
        this.sweepStaleBets();

        // ---- Cashout window ----
        if (this.betManager.isWaitingForResult && inflight && Number.isFinite(state.liveMultiplier)) {
            await this.betManager.checkCashout(frame, state.liveMultiplier);
        }

        // ---- Risk enforcement (stop-loss / take-profit / streak breaker) ----
        const stats = this.statsTracker.getStats();
        if (!this.tradingHalted && this.strategy.shouldStopTrading(stats)) {
            this.haltTrading('risk limits reached (stop-loss / take-profit / loss streak)');
        }

        // ---- Bet placement (every gate must pass) ----
        const balance = parseBalance(state.balanceText);
        const usableBalance = Number.isFinite(balance)
            ? balance - this.config.GAME.MIN_BALANCE_RESERVE
            : null;

        const bettingWindow =
            !inflight &&
            state.betButton.exists &&
            state.betButton.visible &&
            !state.betButton.disabled &&
            state.betButton.text.includes('bet');

        if (
            bettingWindow &&
            !this.tradingHalted &&
            this.cooldownRounds === 0 &&
            !this.betManager.isWaitingForResult &&
            this.multiplierHistory.length >= this.historySize
        ) {
            const avg = this.average(this.multiplierHistory);
            if (avg > this.strategy.averageMultiplierThreshold) {
                logger.debug(`No bet: avg ${avg.toFixed(2)}x > threshold ${this.strategy.averageMultiplierThreshold}`);
            } else {
                const gate = this.predictor ? this.predictor.shouldAllowBet() : { allowed: true };
                if (!gate.allowed) {
                    logger.debug(`Model gate: standing down (${gate.reason})`);
                } else {
                    logger.info(
                        `Bet opportunity (round #${this.roundId + 1}): avg ${avg.toFixed(2)}x, ` +
                        `model ${gate.warmingUp ? 'warming up' : `P=${(gate.probability ?? 0).toFixed(2)}`} ` +
                        `[regime: ${gate.regime || 'n/a'}]`
                    );
                    await this.betManager.placeBet(frame, usableBalance);
                }
            }
        }

        this.emit('status', {
            roundId: this.roundId,
            latestCrash: latest,
            inFlight: inflight,
            balance,
            stats: this.statsTracker.getStats(),
            history: [...this.multiplierHistory],
            cooldownRounds: this.cooldownRounds,
            tradingHalted: this.tradingHalted,
            haltReason: this.haltReason,
            model: this.predictor ? this.predictor.snapshot() : null,
            strategy: {
                name: this.strategy.name,
                nextStake: this.strategy.getNextBetAmount(),
                targetMultiplier: this.strategy.targetMultiplier,
                consecutiveLosses: this.strategy.consecutiveLosses
            }
        });
    }

    /**
     * DOM-jitter guard for round-end detection (see class docs).
     * Returns true when the round end was accepted.
     */
    detectRoundEnd(latest, state) {
        const now = Date.now();
        const sinceLastEnd = this.lastRoundEndedAt ? now - this.lastRoundEndedAt : Infinity;
        if (sinceLastEnd < this.config.GAME.MIN_ROUND_GAP_MS) {
            logger.warn(
                `Bubble changed to ${latest}x only ${sinceLastEnd}ms after the previous round end — ` +
                'deferring one cycle to confirm (jitter guard)'
            );
            return false;
        }
        this.onRoundEnded(latest, state);
        this.lastBubble = latest;
        this.lastRoundEndedAt = now;
        return true;
    }

    /**
     * Guarantees the bet state can never get stuck:
     *  - unarmed bet never confirmed in flight -> written off (BET_STALENESS_MS)
     *  - flight visibly ended but crash bubble never appeared -> written off
     *    after FLIGHT_END_GRACE_MS
     *  - any bet open longer than MAX_BET_LIFETIME_MS -> written off
     * All write-offs are conservative losses, never wins.
     */
    sweepStaleBets() {
        const pending = this.betManager.currentBet;
        if (!pending || pending.settled) return;

        const age = Date.now() - pending.timestamp;

        if (!pending.armed && age > this.config.GAME.BET_STALENESS_MS) {
            logger.warn('Bet could not be confirmed as in-flight — booking conservatively as loss');
            this.betManager.recordLoss(null, { reason: 'unarmed-staleness', roundId: this.roundId });
        } else if (pending.armed && this.flightEndedAt &&
                   Date.now() - this.flightEndedAt > this.config.GAME.FLIGHT_END_GRACE_MS) {
            logger.warn('Flight ended but the crash bubble never appeared — settling round conservatively');
            this.flightEndedAt = null;
            this.betManager.recordLoss(null, { reason: 'flight-end-grace', roundId: this.roundId });
        } else if (age > this.config.GAME.MAX_BET_LIFETIME_MS) {
            logger.warn(
                `Active bet has been open for ${Math.round(age / 1000)}s without a confirmed round end — ` +
                'booking conservatively as loss to unblock the loop'
            );
            this.betManager.recordLoss(null, { reason: 'max-lifetime', roundId: this.roundId });
        }
    }

    /**
     * The newest bubble on the payouts strip changed -> the round that just
     * ended crashed at `crashValue` (the NEW value, not the previous one).
     */
    onRoundEnded(crashValue, state) {
        this.roundId++;
        this.roundInFlight = false;
        this.flightEndedAt = null;
        logger.info(`Round #${this.roundId} ended at ${crashValue}x`);

        // ---- Feed memory + model BEFORE settling the bet ----
        if (this.historyStore) this.historyStore.append(crashValue);
        if (this.predictor) this.predictor.addRound(crashValue);

        // ---- Settle the open bet ----
        const predictionForThisRound = this.nextPrediction;
        const bet = this.betManager.currentBet;
        if (this.betManager.isWaitingForResult && bet && !bet.settled) {
            if (bet.armed) {
                this.betManager.recordLoss(crashValue, { roundId: this.roundId });
            } else {
                bet.unarmedRoundEnds++;
                if (bet.unarmedRoundEnds >= 2) {
                    logger.warn('Bet never observed in flight — booking conservatively as loss');
                    this.betManager.recordLoss(crashValue, { reason: 'never-armed', roundId: this.roundId });
                } else {
                    logger.warn('Round ended before bet was armed — giving it one more round to confirm');
                }
            }
        }

        // ---- Cooldown countdown (safer reset logic) ----
        if (this.cooldownRounds > 0) {
            this.cooldownRounds--;
            if (this.cooldownRounds === 0) {
                logger.info('Cooldown complete — betting may resume');
            }
        }

        // ---- Update session history + prediction ----
        this.multiplierHistory.unshift(crashValue);
        if (this.multiplierHistory.length > this.historySize) {
            this.multiplierHistory.length = this.historySize;
        }
        this.nextPrediction = this.average(this.multiplierHistory);

        this.emit('roundEnded', {
            roundId: this.roundId,
            crash: crashValue,
            predicted: predictionForThisRound,
            nextPrediction: this.nextPrediction,
            history: [...this.multiplierHistory],
            stats: this.statsTracker.getStats(),
            model: this.predictor ? this.predictor.snapshot() : null,
            balanceText: state ? state.balanceText : null
        });
    }

    enterCooldown(rounds, reason) {
        if (rounds <= 0) return;
        this.cooldownRounds = Math.max(this.cooldownRounds, rounds);
        logger.warn(`Entering cooldown for ${this.cooldownRounds} round(s): ${reason}`);
    }

    haltTrading(reason) {
        if (this.tradingHalted) return;
        this.tradingHalted = true;
        this.haltReason = reason;
        const stats = this.statsTracker.getStats();
        logger.warn(
            `TRADING HALTED — ${reason}. ` +
            `netProfit=${stats.netProfit.toFixed(2)}, profit=${stats.totalProfit.toFixed(2)}, ` +
            `loss=${stats.totalLoss.toFixed(2)}, consecutiveLosses=${this.strategy.consecutiveLosses}`
        );
        this.emit('tradingStopped', stats);
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
     * Site-state recovery LADDER. Escalates each time failures persist;
     * never bets blind — final step halts trading entirely.
     */
    async recover() {
        this.recoveryLevel++;
        this.consecutiveFailures = 0;

        // If the page is no longer on the game URL, the session likely died.
        const currentUrl = this.page.url();
        if (this.attachedUrl && currentUrl !== this.attachedUrl &&
            !currentUrl.includes('aviator')) {
            logger.error(
                `Page navigated away from the game (${currentUrl}) — your BetPawa session may have ` +
                'expired. Log in again in the browser window; the bot will keep retrying.'
            );
            this.sessionWarned = true;
        }

        if (this.recoveryLevel === 1) {
            logger.warn('Recovery level 1/3: reloading page and re-baselining');
            try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.NAVIGATION.TIMEOUT });
            } catch (error) {
                logger.error(`Page reload failed: ${error.message}`);
            }
            this.lastBubble = null;
            this.lastRoundEndedAt = null;
            this.roundInFlight = false;
            this.enterCooldown(1, 'page reload recovery');
        } else if (this.recoveryLevel === 2) {
            logger.warn('Recovery level 2/3: requesting re-navigation to the game URL');
            this.emit('needsRenavigation');
            this.lastBubble = null;
            this.lastRoundEndedAt = null;
            this.roundInFlight = false;
            this.enterCooldown(1, 're-navigation recovery');
        } else {
            this.haltTrading('persistent selector failures — site state unrecoverable this session');
        }
    }

    average(values) {
        if (!values || values.length === 0) return Infinity;
        return values.reduce((acc, v) => acc + v, 0) / values.length;
    }
}

module.exports = GameMonitor;
