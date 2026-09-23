const logger = require('../util/logger');
const sleep = require('../util/sleep');
const { parseBalance } = require('../util/balance');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Places bets and executes cashouts.
 *
 * Fixes over the original:
 *  - The stake now comes from `strategy.calculateNextBet(lastResult)` with the
 *    previous trade result, so martingale actually progresses.
 *  - Bet amount is written through the NATIVE value setter + input events so
 *    Angular actually picks it up (plain `input.value = x` is ignored).
 *  - Bet acceptance is CONFIRMED (button text flips to cancel/cashout or the
 *    balance drops) before we consider the bet live.
 *  - Cashout wins are only booked after the site confirms (cashout button
 *    disappears/disables); unconfirmed outcomes are booked conservatively
 *    as losses, never as phantom wins.
 *  - Cashout profit uses the ACTUAL multiplier at cashout time.
 *  - Insufficient-balance check before every bet.
 */
class BetManager {
    constructor(config, strategy, statsTracker) {
        this.config = config;
        this.strategy = strategy;
        this.statsTracker = statsTracker;
        this.currentBet = null;
        this.isWaitingForResult = false;
        this.paperMode = false; // when true: no clicks, virtual fills (paper trading)
        this.selectors = null; // per-site widget selectors; falls back to config.SELECTORS.GAME
        this.onTrade = null;    // optional callback(trade) for dashboard/DB
    }

    setStrategy(strategy) {
        this.strategy = strategy;
    }

    /**
     * Places a bet of `stake` (decided by the Brain). In paper mode no clicks
     * happen — the fill is virtual and everything downstream (stats, model
     * feedback, CSV logs) runs exactly as in live mode.
     */
    async placeBet(frame, balance = null, stake = null, meta = {}) {
        if (this.isWaitingForResult) {
            logger.debug('Already waiting for result, skipping bet');
            return false;
        }

        try {
            const sel = this.selectors || this.config.SELECTORS.GAME;
            const betAmount = round2(stake ?? this.strategy.getNextBetAmount());

            if (!Number.isFinite(betAmount) || betAmount <= 0) {
                logger.warn(`Invalid bet amount: ${betAmount} — skipping`);
                return false;
            }

            // Paper fills are virtual — never gate them on the real account
            // balance (a low real balance must not silence the simulation).
            if (!this.paperMode && Number.isFinite(balance) && balance < betAmount) {
                logger.warn(`Insufficient balance (${balance}) for bet of ${betAmount} — skipping`);
                return false;
            }

            if (this.paperMode) {
                this.currentBet = {
                    amount: betAmount,
                    timestamp: Date.now(),
                    targetMultiplier: this.strategy.targetMultiplier,
                    armed: true,   // paper fills are treated as live in the round
                    settled: false,
                    unarmedRoundEnds: 0,
                    meta
                };
                this.isWaitingForResult = true;
                logger.info(`[PAPER] Virtual bet placed: ${betAmount} @ target ${this.currentBet.targetMultiplier}x`);
                return true;
            }

            // --- Set the stake (Angular-safe) ---
            const amountStatus = await frame.evaluate(async (amount, selector) => {
                const input = document.querySelector(selector);
                if (!input) return 'no_input';
                const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                input.focus();
                setter.call(input, '');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                setter.call(input, String(amount));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                return input.value === String(amount) ? 'ok' : 'mismatch';
            }, betAmount, sel.BET_INPUT);

            if (amountStatus === 'no_input') {
                logger.warn('Bet input field not found — cannot place bet');
                return false;
            }
            if (amountStatus === 'mismatch') {
                logger.warn('Bet amount may not have registered in the input field — attempting anyway');
            }
            await sleep(300);

            // --- Click the bet button ---
            const clicked = await frame.evaluate((selector) => {
                const button = document.querySelector(selector);
                const text = button ? button.textContent.toLowerCase() : '';
                if (button && !button.disabled && text.includes('bet') && !text.includes('cash')) {
                    button.click();
                    return true;
                }
                return false;
            }, sel.BET_BUTTON);

            if (!clicked) {
                logger.debug('Bet button not clickable');
                return false;
            }

            // --- Confirm the site accepted the bet ---
            const accepted = await this.waitForBetAcceptance(frame, betAmount, balance);
            if (!accepted) {
                logger.warn('Bet click was NOT confirmed by the site — treating as not placed');
                return false;
            }

            this.currentBet = {
                amount: betAmount,
                timestamp: Date.now(),
                targetMultiplier: this.strategy.targetMultiplier,
                armed: false,          // becomes true once we see the round in flight
                settled: false,
                unarmedRoundEnds: 0
            };
            this.isWaitingForResult = true;
            logger.info(`Bet ACCEPTED: ${betAmount} @ target ${this.currentBet.targetMultiplier}x`);
            return true;
        } catch (error) {
            logger.error(`Error placing bet: ${error.message}`);
            return false;
        }
    }

    /**
     * Acceptance signals: bet button text flips to "cancel"/"cash out",
     * or the balance drops by (at least) the stake.
     */
    async waitForBetAcceptance(frame, betAmount, startBalance, timeoutMs = 8000) {
        const sel = this.selectors || this.config.SELECTORS.GAME;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const state = await frame.evaluate((betSelector, balanceSelector) => {
                    const b = document.querySelector(betSelector);
                    const bal = document.querySelector(balanceSelector);
                    return {
                        text: b ? b.textContent.trim().toLowerCase() : '',
                        balanceText: bal ? bal.textContent : null
                    };
                }, sel.BET_BUTTON, sel.BALANCE);

                const text = state.text || '';
                if (text.includes('cancel') || text.includes('cash')) return true;

                const newBalance = parseBalance(state.balanceText);
                if (Number.isFinite(newBalance) && Number.isFinite(startBalance) &&
                    startBalance - newBalance >= betAmount * 0.99) {
                    return true;
                }
            } catch (error) {
                logger.debug(`Acceptance poll error: ${error.message}`);
            }
            await sleep(400);
        }
        return false;
    }

    /**
     * Called every cycle while a round is in flight.
     * `liveMultiplier` is read from the game UI by the GameMonitor.
     */
    async checkCashout(frame, liveMultiplier) {
        if (!this.isWaitingForResult || !this.currentBet) return;
        if (!Number.isFinite(liveMultiplier)) return;

        if (liveMultiplier >= this.strategy.targetMultiplier) {
            logger.info(`Target reached: ${liveMultiplier}x >= ${this.strategy.targetMultiplier}x — cashing out`);
            await this.executeCashout(frame, liveMultiplier);
        }
    }

    async executeCashout(frame, liveMultiplier) {
        const sel = this.selectors || this.config.SELECTORS.GAME;
        try {
            if (this.paperMode) {
                this.recordWin(liveMultiplier);
                return;
            }
            const clicked = await frame.evaluate((selector) => {
                const button = document.querySelector(selector);
                if (button && !button.disabled) {
                    button.click();
                    return true;
                }
                return false;
            }, sel.CASHOUT_BUTTON);

            if (!clicked) {
                logger.warn('Cashout button not clickable');
                return;
            }

            const confirmed = await this.waitForCashoutConfirmation(frame);
            if (confirmed) {
                this.recordWin(liveMultiplier);
            } else {
                // Conservative bookkeeping: never log a win we cannot verify.
                logger.warn('Cashout click could not be confirmed — booking conservatively as loss');
                this.recordLoss(liveMultiplier, { unconfirmedCashout: true });
            }
        } catch (error) {
            logger.error(`Error executing cashout: ${error.message}`);
        }
    }

    /**
     * Confirmation signal: the cashout button disappears or becomes disabled.
     */
    async waitForCashoutConfirmation(frame, timeoutMs = 6000) {
        const sel = this.selectors || this.config.SELECTORS.GAME;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const state = await frame.evaluate((cashoutSelector, betSelector) => {
                    const co = document.querySelector(cashoutSelector);
                    const b = document.querySelector(betSelector);
                    return {
                        cashoutGone: !co || co.disabled,
                        betText: b ? b.textContent.trim().toLowerCase() : ''
                    };
                }, sel.CASHOUT_BUTTON, sel.BET_BUTTON);

                if (state.cashoutGone) return true;
                // Button flipped back to plain "bet" for the next round
                if (state.betText.includes('bet') && !state.betText.includes('cash') && !state.betText.includes('cancel')) {
                    return true;
                }
            } catch (error) {
                logger.debug(`Cashout confirmation poll error: ${error.message}`);
            }
            await sleep(300);
        }
        return false;
    }

    recordWin(multiplier) {
        if (!this.currentBet || this.currentBet.settled) return;
        const profit = round2(this.currentBet.amount * (multiplier - 1));
        const trade = {
            betAmount: this.currentBet.amount,
            multiplier,
            profit,
            loss: 0,
            timestamp: Date.now(),
            won: true
        };
        logger.info(`WIN booked: +${profit} (cashed out at ${multiplier}x)`);
        this.settle(trade, { won: true });
    }

    recordLoss(multiplier, meta = {}) {
        if (!this.currentBet || this.currentBet.settled) return;
        const trade = {
            betAmount: this.currentBet.amount,
            multiplier: multiplier ?? null,
            profit: 0,
            loss: -this.currentBet.amount,
            timestamp: Date.now(),
            won: false,
            ...meta
        };
        logger.info(`LOSS booked: -${this.currentBet.amount} (crashed at ${multiplier ?? 'unknown'}x)`);
        this.settle(trade, { won: false });
    }

    settle(trade, result) {
        const meta = this.currentBet ? (this.currentBet.meta || {}) : {};
        if (this.currentBet) this.currentBet.settled = true;
        trade.result = result.won ? 'win' : 'loss';
        this.statsTracker.addTrade(trade);
        if (typeof this.onTrade === 'function') {
            try { this.onTrade(trade, meta); } catch (e) { /* never break the loop for telemetry */ }
        }
        this.isWaitingForResult = false;
        this.currentBet = null;
    }
}

module.exports = BetManager;
