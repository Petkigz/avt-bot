const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const BettingStrategy = require('./strategies');
const StatsTracker = require('./statsTracker');
const BetManager = require('./betManager');
const FrameHelper = require('../util/frameHelper');
const { parseBalance } = require('../util/balance');
const logger = require('../util/logger');

/**
 * Watches one game page and drives the loop. All BETTING DECISIONS go through
 * the Brain (shared with paper mode and the simulator), so live behavior is
 * exactly what was simulated.
 *
 * Round detection (multi-signal, hardened):
 *  - payouts strip only changes when a round CRASHES (newest bubble = crash)
 *  - jitter guard defers implausibly fast changes one cycle
 *  - flight-end fallback settles rounds whose bubble never updates
 *  - every accepted round end increments `roundId` (audit trail + CSV)
 *
 * Site-state recovery ladder on repeated selector failures:
 *  level 1 reload -> level 2 re-navigate -> level 3 HALT trading.
 *
 * Events: roundStarted, roundEnded, trade, tradingStopped, status,
 *         needsRenavigation
 */
class GameMonitor extends EventEmitter {
    constructor(page, config, brain, deps = {}) {
        super();
        this.page = page;
        this.config = config;
        this.brain = brain;
        this.historyStore = deps.historyStore || null;
        this.csvRounds = deps.csvRounds || null;
        this.selectors = deps.selectors || config.SELECTORS.GAME; // per-site widget selectors
        this.site = deps.site || '';      // which site this monitor watches
        this.account = deps.account || ''; // which account label it belongs to

        this.strategy = brain.strategy;
        this.statsTracker = new StatsTracker();
        this.betManager = new BetManager(config, this.strategy, this.statsTracker);
        this.betManager.paperMode = !!(config.MODE && config.MODE.PAPER);
        this.betManager.selectors = this.selectors; // bet/cashout clicks use the site widget

        this.multiplierHistory = [];
        this.historySize = config.GAME.HISTORY_SIZE;
        this.lastBubble = null;
        this.lastRoundEndedAt = null;
        this.roundId = 0;
        this.roundInFlight = false;
        this.flightEndedAt = null;
        this.tradingHalted = false;
        this.haltReason = null;
        this.cooldownRounds = 0;
        this.stopped = false;
        this.monitoring = false;     // re-entrancy lock
        this.consecutiveFailures = 0;
        this.recoveryLevel = 0;
        this.missingButtonCycles = 0;
        this.attachedUrl = null;
        this.timer = null;
        this.nextPrediction = null;
        this.lastBalance = null;    // last balance read from the game page
        this.currency = deps.currency || ''; // site currency, for balance scanning
        this.balanceScanCycle = 0;
        this.seedEmitted = false;   // history-strip seed sent once per attach
        this.stripPath = null;      // content-discovered history strip (new Spribe layouts)
        this.stripAnnounced = false;
        this.stripLogged = false;
        this.prevBubbles = null;    // for auto-detecting which end of the strip is newest
        this.newestEnd = null;      // 'head' | 'tail' once detected
        this.emptyStripCycles = 0;
        this.stuckLatest = null;
        this.stuckCycles = 0;
        this.roundBetMeta = null; // {stake, confidence, pattern, tier} of this round's bet

        // Every settled trade feeds the Brain (model, patterns, bankroll,
        // tier promotion) plus the dashboard/DB/CSV.
        this.betManager.onTrade = (trade, meta) => {
            this.brain.recordOutcome(trade, meta);
            this.emit('trade', trade);
        };
    }

    mode() {
        return this.betManager.paperMode ? 'paper' : 'live';
    }

    startMonitoring() {
        if (this.timer) return;
        logger.info(
            `Starting game monitoring [${this.mode().toUpperCase()} mode] ` +
            `strategy=${this.strategy.name} tier=${this.brain.tier}`
        );
        this.timer = setInterval(() => this.tick(), this.config.GAME.POLLING_INTERVAL);
        this.tick();
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
        const sel = this.selectors;
        // Classic layout first (fast path); fall back to CONTENT-based strip
        // discovery — new-generation Spribe clients ("aviator-next") do not
        // use the historical class names.
        let marker = null;
        try {
            const frame = await FrameHelper.findFrameWithSelector(this.page, sel.BUBBLE_MULTIPLIER);
            if (frame) marker = { frame, stripPath: null };
        } catch (error) { /* page busy */ }
        if (!marker) {
            try { marker = await FrameHelper.findMultiplierStrip(this.page); } catch (error) { /* busy */ }
        }
        if (!marker) return; // nothing rendered yet — the tick retries

        if (marker.stripPath && !this.stripAnnounced) {
            this.stripAnnounced = true;
            logger.warn(
                `Round history detected via content scan (new Spribe layout). ` +
                'Observation and analysis work normally; live-bet button selectors may ' +
                'need an update for this layout before LIVE mode can click.'
            );
        }
        this.stripPath = marker.stripPath;

        let state = await this.readState(marker.frame, marker.stripPath);
        if (!state) return;
        // Classic selectors can match hidden/template elements that yield no
        // parseable rounds — fall back to the content-discovered strip then.
        if (state.bubbles.length === 0 && !marker.stripPath) {
            try {
                const strip = await FrameHelper.findMultiplierStrip(this.page);
                if (strip) {
                    if (!this.stripAnnounced) {
                        this.stripAnnounced = true;
                        logger.warn('Classic selectors matched a hidden element — switching to the content-discovered round strip');
                    }
                    marker = { frame: strip.frame, stripPath: strip.path };
                    this.stripPath = strip.path;
                    const alt = await this.readState(marker.frame, marker.stripPath);
                    if (alt) state = alt;
                }
            } catch (error) { /* frame busy */ }
        }
        if (!this.attachedUrl) this.attachedUrl = this.page.url();

        // ---- Auto-detect which END of the strip carries the newest round
        // (layouts differ; classic = newest first, some clients append). ----
        if (this.newestEnd === null && this.prevBubbles &&
            state.bubbles.length >= 2 && this.prevBubbles.length >= 2) {
            const headChanged = state.bubbles[0] !== this.prevBubbles[0];
            const tailChanged = state.bubbles[state.bubbles.length - 1] !==
                this.prevBubbles[this.prevBubbles.length - 1];
            if (headChanged && !tailChanged) this.newestEnd = 'head';
            else if (tailChanged && !headChanged) {
                this.newestEnd = 'tail';
                logger.info('Round-history strip appends new rounds at the END — reading order adapted automatically');
            }
        }
        this.prevBubbles = state.bubbles;
        const bubblesNorm = this.newestEnd === 'tail' ? [...state.bubbles].reverse() : state.bubbles;

        // ---- Fallback-mode telemetry (explains a silent strip) ----
        if (marker.stripPath) {
            if (state.bubbles.length > 0) {
                this.emptyStripCycles = 0;
                if (!this.stripLogged) {
                    this.stripLogged = true;
                    logger.info(`History strip found at "${marker.stripPath}" — ${state.bubbles.length} rounds visible, latest ${bubblesNorm[0]}x`);
                }
                if (bubblesNorm[0] === this.stuckLatest) {
                    this.stuckCycles++;
                    if (this.stuckCycles === 90) {
                        logger.warn(
                            'History strip has not changed for ~90 polling cycles. If rounds ARE crashing on ' +
                            'screen, the detected panel is probably the wrong one — use "Diagnose game frame" ' +
                            'in the dashboard and share the output.'
                        );
                    }
                } else {
                    this.stuckLatest = bubblesNorm[0];
                    this.stuckCycles = 0;
                }
            } else {
                this.emptyStripCycles++;
                if (this.emptyStripCycles === 15) {
                    try {
                        const raw = await marker.frame.evaluate((p) => {
                            const c = document.querySelector(p);
                            if (!c) return '(container vanished)';
                            return Array.from(c.children).slice(0, 12)
                                .map((el) => JSON.stringify((el.textContent || '').trim())).join(', ');
                        }, marker.stripPath);
                        logger.warn(`History strip container has no parseable rounds. Raw children: ${raw || '(none)'}`);
                    } catch (error) { /* frame busy */ }
                }
            }
        }

        // One-shot: hand the visible history strip (newest-first) to the
        // orchestrator so long-term memory seeds from what's already on screen.
        if (!this.seedEmitted && bubblesNorm.length > 0) {
            this.seedEmitted = true;
            this.emit('seedHistory', [...bubblesNorm].reverse());
        }

        const latest = bubblesNorm.length > 0 ? bubblesNorm[0] : null;
        if (latest === null) {
            logger.debug('No crash bubbles rendered yet');
            return;
        }

        // ---- Round-end detection / baseline ----
        if (this.lastBubble === null) {
            this.lastBubble = latest;
            if (this.multiplierHistory.length === 0) {
                this.multiplierHistory = bubblesNorm.slice(0, this.historySize);
                logger.info(`Seeded session history from payouts strip: [${this.multiplierHistory.join(', ')}]`);
            }
            logger.info(`Baseline crash value: ${latest}x`);
        } else if (latest !== this.lastBubble) {
            this.detectRoundEnd(latest, state);
        }

        // ---- Selector-drift alarm (fail LOUDLY, not silently) ----
        // Suppressed in content-scan fallback mode: the new layout simply has
        // different button classes, which is expected, not drift.
        if (state.betButton.exists) {
            this.missingButtonCycles = 0;
        } else if (!this.stripPath) {
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
            this.flightEndedAt = Date.now();
        }

        // ---- Balance into the bankroll manager ----
        // Classic selector first; newer layouts show the balance in the SITE
        // SHELL (navbar) instead of the game frame — scan for it, throttled.
        if (!state.balanceText) {
            this.balanceScanCycle++;
            if (this.balanceScanCycle % 8 === 1) {
                try { state.balanceText = await this.findBalanceText(); } catch (error) { /* busy */ }
            }
        }
        const balance = parseBalance(state.balanceText);
        if (Number.isFinite(balance)) this.lastBalance = balance;
        if (Number.isFinite(balance) && this.brain.bankroll) {
            this.brain.bankroll.setBalance(balance);
        }

        // ---- Stale/stuck bet sweep ----
        this.sweepStaleBets();

        // ---- Cashout window ----
        // Paper bets are deliberately excluded: on some layouts the
        // multiplier element keeps showing the PREVIOUS crash between
        // rounds, which would book false early wins. Paper bets settle
        // exactly against the next crash value at the round boundary.
        if (!this.betManager.paperMode && this.betManager.isWaitingForResult && inflight && Number.isFinite(state.liveMultiplier)) {
            await this.betManager.checkCashout(marker.frame, state.liveMultiplier);
        }

        // ---- Risk enforcement (strategy-level stop-loss / take-profit / streak) ----
        const stats = this.statsTracker.getStats();
        if (!this.tradingHalted && this.strategy.shouldStopTrading(stats)) {
            this.haltTrading('strategy risk limits reached (stop-loss / take-profit / loss streak)');
        }
        if (!this.tradingHalted && this.brain.bankroll && this.brain.bankroll.halted) {
            this.haltTrading(`bankroll guard: ${this.brain.bankroll.haltReason}`);
        }

        // ---- THE decision (all gates live inside Brain.decide) ----
        // Paper mode never clicks, so it must not depend on the real bet
        // button existing (next-gen layouts use different selectors) — the
        // window is simply "between rounds". Live mode still needs a real,
        // clickable bet button.
        const bettingWindow = this.betManager.paperMode
            ? !inflight
            : (!inflight &&
                state.betButton.exists &&
                state.betButton.visible &&
                !state.betButton.disabled &&
                state.betButton.text.includes('bet'));

        const decision = this.brain.decide({
            bettingWindow,
            balance: this.betManager.paperMode
                ? null // paper: sizing/gates use the simulated bankroll, not the real balance
                : (Number.isFinite(balance)
                    ? balance - this.config.GAME.MIN_BALANCE_RESERVE
                    : null),
            cooldownRounds: this.cooldownRounds,
            halted: this.tradingHalted
        });

        if (bettingWindow && decision.shouldBet && !this.betManager.paperMode) {
            logger.info(
                `[${this.mode().toUpperCase()}] BET round #${this.roundId + 1}: stake ${decision.stake} | ` +
                `tier ${decision.tier} | confidence ${(decision.confidence ?? 0).toFixed(2)} | ` +
                `pattern ${decision.pattern ? decision.pattern.pattern : 'none'}`
            );
            const ok = await this.betManager.placeBet(marker.frame, balance, decision.stake, {
                confidence: decision.confidence,
                pattern: decision.pattern,
                tier: decision.tier,
                targetMultiplier: decision.targetMultiplier // ADAPTIVE: per-round target
            });
            if (ok) {
                this.roundBetMeta = {
                    stake: decision.stake,
                    confidence: decision.confidence,
                    pattern: decision.pattern ? decision.pattern.pattern : '',
                    tier: decision.tier
                };
            }
        } else if (bettingWindow && this.cooldownRounds === 0 && !this.tradingHalted &&
                   !this.betManager.isWaitingForResult && decision.reasons.length) {
            logger.debug(`Standing down: ${decision.reasons.join('; ')}`);
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
            decision: this.brain.lastDecision,
            brain: this.brain.snapshot(),
            strategy: {
                name: this.strategy.name,
                nextStake: this.strategy.getNextBetAmount(),
                initialBet: this.strategy.initialBet,
                minBet: this.strategy.minBet,
                maxBet: this.strategy.maxBet,
                targetMultiplier: this.strategy.targetMultiplier,
                adaptiveTarget: this.strategy.adaptiveTarget === true,
                adaptiveMin: this.strategy.adaptiveMin,
                adaptiveMax: this.strategy.adaptiveMax,
                martingaleMultiplier: this.strategy.martingaleMultiplier,
                stopLoss: this.strategy.stopLoss,
                takeProfit: this.strategy.takeProfit,
                consecutiveLosses: this.strategy.consecutiveLosses
            }
        });
    }

    /**
     * DOM-jitter guard for round-end detection.
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
     * Guarantees the bet state can never get stuck. All write-offs are
     * conservative losses, never wins.
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
     * The newest bubble changed -> the round that just ended crashed at
     * `crashValue` (the NEW value, not the previous one).
     */
    onRoundEnded(crashValue, state) {
        this.roundId++;
        this.roundInFlight = false;
        this.flightEndedAt = null;
        logger.info(`Round #${this.roundId} ended at ${crashValue}x [${this.site}${this.account ? ' / ' + this.account : ''}]`);

        // ---- Feed memory + model BEFORE settling the bet ----
        if (this.historyStore) this.historyStore.append(crashValue);
        this.brain.onRoundEnded(crashValue);

        // ---- Settle the open bet ----
        const bet = this.betManager.currentBet;
        if (this.betManager.isWaitingForResult && bet && !bet.settled) {
            if (this.betManager.paperMode) {
                // Paper fills settle EXACTLY against the crash value — no
                // reliance on the in-flight multiplier element, which varies
                // across site layouts.
                this.betManager.settlePaperRound(crashValue);
            } else if (bet.armed) {
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

        // ---- Paper mode: decide the NEXT round right at the round boundary.
        // Event-driven, so it never depends on the site's bet button or the
        // live-multiplier element (both vary across layouts); settlement of
        // this bet happens against the next crash value above. ----
        if (this.betManager.paperMode && !this.tradingHalted) {
            const decision = this.brain.decide({
                bettingWindow: true,
                balance: null, // paper: sizing uses the simulated bankroll
                cooldownRounds: this.cooldownRounds,
                halted: false
            });
            if (decision.shouldBet && decision.stake > 0) {
                const isAdaptive = this.brain.strategy && this.brain.strategy.adaptiveTarget;
                logger.info(
                    `[PAPER] BET round #${this.roundId + 1}: stake ${decision.stake} | ` +
                    `target ${decision.targetMultiplier}x${isAdaptive ? ' (model-chosen)' : ''} | ` +
                    `tier ${decision.tier} | confidence ${(decision.confidence ?? 0).toFixed(2)} | ` +
                    `pattern ${decision.pattern ? decision.pattern.pattern : 'none'}`
                );
                this.betManager.placeBet(null, null, decision.stake, {
                    confidence: decision.confidence,
                    pattern: decision.pattern,
                    tier: decision.tier,
                    targetMultiplier: decision.targetMultiplier // ADAPTIVE: per-round target
                }).catch((error) => logger.error(`Paper bet placement failed: ${error.message}`));
            } else if (decision.reasons.length) {
                logger.debug(`[PAPER] Standing down round #${this.roundId + 1}: ${decision.reasons.join('; ')}`);
            }
        }

        // ---- Session history + prediction ----
        this.multiplierHistory.unshift(crashValue);
        if (this.multiplierHistory.length > this.historySize) {
            this.multiplierHistory.length = this.historySize;
        }
        this.nextPrediction = this.average(this.multiplierHistory);

        // ---- Round-by-round CSV row ----
        const lastTrade = this.statsTracker.trades.length
            ? this.statsTracker.trades[this.statsTracker.trades.length - 1] : null;
        const betWasThisRound = this.roundBetMeta !== null;
        if (this.csvRounds) {
            this.csvRounds.write({
                ts: new Date().toISOString(),
                mode: this.mode(),
                site: this.site,
                account: this.account,
                roundId: this.roundId,
                crash: crashValue,
                betPlaced: betWasThisRound ? 'yes' : 'no',
                stake: betWasThisRound ? this.roundBetMeta.stake : '',
                outcome: betWasThisRound && lastTrade ? (lastTrade.won ? 'win' : 'loss') : 'none',
                pnl: betWasThisRound && lastTrade ? (lastTrade.won ? lastTrade.profit : lastTrade.loss) : 0,
                confidence: this.roundBetMeta ? (this.roundBetMeta.confidence ?? '') : '',
                pattern: this.roundBetMeta ? this.roundBetMeta.pattern : '',
                tier: this.brain.tier,
                regime: this.brain.predictor ? this.brain.predictor.regime() : ''
            });
        }
        this.roundBetMeta = null;

        this.emit('roundEnded', {
            roundId: this.roundId,
            crash: crashValue,
            nextPrediction: this.nextPrediction,
            history: [...this.multiplierHistory],
            stats: this.statsTracker.getStats(),
            brain: this.brain.snapshot(),
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
        this.saveDebugScreenshot('halted');
    }

    /**
     * Saves a timestamped screenshot for post-mortem debugging (max 20 kept).
     * Fire-and-forget: never throws into the monitoring loop.
     */
    saveDebugScreenshot(tag) {
        (async () => {
            try {
                if (!this.page || this.page.isClosed()) return;
                const dir = path.join(this.config.DATA_DIR, 'screenshots');
                fs.mkdirSync(dir, { recursive: true });
                const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
                while (files.length >= 20) fs.unlinkSync(path.join(dir, files.shift()));
                const file = path.join(dir, `${tag}-${this.site || 'site'}-${Date.now()}.png`);
                await this.page.screenshot({ path: file });
                logger.warn(`Debug screenshot saved: ${file}`);
            } catch (error) {
                logger.debug(`Debug screenshot failed: ${error.message}`);
            }
        })();
    }

    /**
     * Reads all needed DOM state in ONE evaluate round-trip.
     * stripPath: when set, bubbles come from the content-discovered strip
     * container (new Spribe layouts) instead of the classic selector.
     */
    async readState(frame, stripPath = null) {
        try {
            const sel = this.selectors;
            return await frame.evaluate((s, path) => {
                const q = (selector) => document.querySelector(selector);
                const visible = (el) => {
                    if (!el) return false;
                    const box = el.getBoundingClientRect();
                    return box.width > 0 && box.height > 0;
                };
                // "1.23x" -> 1.23 ; "1,105.31x" -> 1105.31 (thousands comma);
                // "2,5x" -> 2.5 (decimal comma, only when no dot is present)
                const toMult = (text) => {
                    let t = (text || '').trim().replace(/x/gi, '');
                    if (t.includes(',') && t.includes('.')) t = t.replace(/,/g, '');
                    else t = t.replace(',', '.');
                    return parseFloat(t);
                };
                let bubbles;
                if (path) {
                    const container = document.querySelector(path);
                    bubbles = container
                        ? Array.from(container.children)
                            .map((el) => toMult(el.textContent))
                            .filter((v) => Number.isFinite(v) && v > 0)
                            .slice(0, 12)
                        : [];
                } else {
                    bubbles = Array.from(document.querySelectorAll(s.BUBBLE_MULTIPLIER))
                        .map((el) => toMult(el.textContent))
                        .filter((v) => Number.isFinite(v) && v > 0)
                        .slice(0, 30);
                }

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
            }, sel, stripPath || null);
        } catch (error) {
            logger.error(`Error reading game state: ${error.message}`);
            return null;
        }
    }

    /**
     * Live diagnostic snapshot for the dashboard "Diagnose game frame" button.
     * Reports which marker matched, what bubbles parse to, and a raw sample of
     * the discovered strip so layout issues are visible without DevTools.
     */
    async dumpState() {
        const sel = this.selectors;
        const out = {
            site: this.site,
            account: this.account,
            mode: this.mode(),
            roundId: this.roundId,
            lastBubble: this.lastBubble,
            newestEnd: this.newestEnd,
            stripPath: this.stripPath,
            recentHistory: this.multiplierHistory.slice(0, 12),
            frames: []
        };
        try {
            out.frames = this.page.frames().map((f) => f.url()).filter(Boolean);
            let marker = null;
            try {
                const f = await FrameHelper.findFrameWithSelector(this.page, sel.BUBBLE_MULTIPLIER);
                if (f) marker = { frame: f, stripPath: null };
            } catch (error) { /* busy */ }
            if (!marker) marker = await FrameHelper.findMultiplierStrip(this.page);
            if (!marker) {
                out.marker = 'none — neither classic selectors nor content scan found the round history';
                return out;
            }
            out.marker = marker.stripPath ? `content scan: ${marker.stripPath}` : 'classic selectors';
            let state = await this.readState(marker.frame, marker.stripPath);
            // Same verification the monitor does: empty classic match -> content scan
            if (state && state.bubbles.length === 0 && !marker.stripPath) {
                const strip = await FrameHelper.findMultiplierStrip(this.page);
                if (strip) {
                    marker = { frame: strip.frame, stripPath: strip.path };
                    out.marker = `classic matched but empty -> content scan: ${strip.path}`;
                    const alt = await this.readState(marker.frame, marker.stripPath);
                    if (alt) state = alt;
                }
            }
            out.parsedBubbles = state ? state.bubbles : null;
            out.betButton = state ? state.betButton : null;
            out.cashoutButton = state ? state.cashoutButton : null;
            if (marker.stripPath) {
                out.rawStripSample = await marker.frame.evaluate((p) => {
                    const c = document.querySelector(p);
                    return c ? Array.from(c.children).slice(0, 12).map((el) => (el.textContent || '').trim()) : null;
                }, marker.stripPath);
            }
            // Live-betting readiness: does the stake input exist in this layout?
            try {
                out.betInput = await marker.frame.evaluate((s) => {
                    const i = document.querySelector(s.BET_INPUT);
                    return i ? { exists: true, currentValue: i.value } : { exists: false };
                }, this.selectors);
            } catch (error) { out.betInput = { error: error.message }; }
        } catch (error) {
            out.error = error.message;
        }
        return out;
    }

    /**
     * Cross-frame balance hunt for layouts where the balance lives in the
     * site shell (navbar) rather than the game widget: finds elements with
     * balance-ish class/id/test attributes and extracts a currency amount.
     */
    async findBalanceText() {
        const cur = /^[A-Za-z]{2,8}$/.test(this.currency) ? this.currency.toUpperCase() : '';
        for (const frame of this.page.frames()) {
            try {
                const text = await frame.evaluate((currency) => {
                    const nodes = document.querySelectorAll(
                        '[class*="balance" i], [id*="balance" i], [data-test-id*="balance" i]'
                    );
                    const rx = currency
                        ? new RegExp(`(${currency}\\s*[\\d][\\d,]*(?:\\.\\d{1,2})?)`)
                        : /([\d][\d,]*(?:\.\d{1,2})?)/;
                    for (const el of nodes) {
                        const m = ((el.textContent || '').trim()).match(rx);
                        if (m) return m[1];
                    }
                    return null;
                }, cur);
                if (text) return text;
            } catch (error) { /* frame busy or detached */ }
        }
        return null;
    }

    /**
     * Site-state recovery LADDER (reload -> re-navigate -> halt).
     */
    async recover() {
        this.recoveryLevel++;
        this.consecutiveFailures = 0;
        this.saveDebugScreenshot(`recover-L${this.recoveryLevel}`);

        const currentUrl = this.page.url();
        if (this.attachedUrl && currentUrl !== this.attachedUrl &&
            !currentUrl.includes('aviator')) {
            logger.error(
                `Page navigated away from the game (${currentUrl}) — your ${this.site || 'site'} login ` +
                'session may have expired. Log in again in the browser window; the bot will keep retrying.'
            );
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
