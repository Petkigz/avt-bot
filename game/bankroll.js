const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');

/**
 * Bankroll manager — the hard money guard.
 *
 * Rules (all enforced BEFORE any bet is allowed):
 *  - session loss limit: stop forever this session when hit
 *  - daily loss limit: persists across restarts, resets at midnight (local)
 *  - max stake fraction: a single stake can never exceed a small fraction
 *    of the bankroll (default 2%)
 *  - MICRO tier cap: while the bot is unproven, stakes are capped at a tiny
 *    fraction of the bankroll
 *
 * State (daily P/L, starting bankroll) persists to data/bankroll.json.
 */
class Bankroll {
    constructor(options = {}) {
        this.file = options.file || null;
        this.sessionLossLimit = options.sessionLossLimit ?? Infinity;
        this.dailyLossLimit = options.dailyLossLimit ?? Infinity;
        this.maxStakeFraction = options.maxStakeFraction ?? 0.02;
        this.microStakeFraction = options.microStakeFraction ?? 0.005;
        this.minStake = options.minStake ?? 0;

        this.balance = null;
        this.startingBalance = null;
        this.paperReference = 0; // >0 in paper mode: simulated bankroll, real balance ignored
        this.sessionPnl = 0;
        this.halted = false;
        this.haltReason = null;
        this.daily = { date: Bankroll.today(), pnl: 0 };
        this.trades = 0;
    }

    static today() {
        return new Date().toISOString().slice(0, 10);
    }

    static load(file, options = {}) {
        const bankroll = new Bankroll({ ...options, file });
        try {
            if (file && fs.existsSync(file)) {
                const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (saved.daily && saved.daily.date === Bankroll.today()) {
                    bankroll.daily = { date: saved.daily.date, pnl: saved.daily.pnl | 0 };
                }
                if (Number.isFinite(saved.startingBalance)) {
                    bankroll.startingBalance = saved.startingBalance;
                }
                bankroll.trades = saved.trades | 0;
            }
        } catch (error) {
            logger.warn(`Could not load bankroll state (${error.message}) — starting fresh`);
        }
        return bankroll;
    }

    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify({
                daily: this.daily,
                startingBalance: this.startingBalance,
                trades: this.trades
            }, null, 2));
        } catch (error) {
            logger.warn(`Could not persist bankroll state: ${error.message}`);
        }
    }

    /**
     * Live balance from the site. The first real balance seen becomes the
     * session's starting bankroll reference.
     */
    setBalance(balance) {
        if (!Number.isFinite(balance)) return;
        if (this.paperReference > 0) return; // paper mode keeps its simulated bankroll
        this.balance = balance;
        if (this.startingBalance === null && balance > 0) {
            this.startingBalance = balance;
            logger.info(`Bankroll reference set: ${balance}`);
        }
        this.rollDailyIfNeeded();
    }

    /**
     * Paper mode runs against the strategy's ASSUMED capital, not the real
     * account balance — a real balance below the minimum stake must not
     * silence the paper simulation (no real money moves either way).
     */
    setPaperReference(amount) {
        if (!Number.isFinite(amount) || amount <= 0) return;
        this.paperReference = amount;
        this.balance = amount;
        this.startingBalance = amount;
        // An explicit bankroll reset from the dashboard is a deliberate
        // "fresh session" act: clear the session loss ledger and any SESSION
        // halt with it. Otherwise the guard latches forever — the reset
        // button would look like it worked while trading stays silently dead.
        // A DAILY halt survives: that commitment is date-bound, not
        // bankroll-bound.
        this.sessionPnl = 0;
        if (this.halted && typeof this.haltReason === 'string' && this.haltReason.startsWith('session')) {
            this.halted = false;
            this.haltReason = null;
            logger.info('Bankroll guard: session halt cleared by bankroll reset (daily limits still stand)');
        }
        logger.info(`Paper bankroll reference set: ${amount} (real balance ignored for sizing/gates)`);
    }

    rollDailyIfNeeded() {
        const today = Bankroll.today();
        if (this.daily.date !== today) {
            logger.info(`New day — daily P/L reset (yesterday: ${this.daily.pnl})`);
            this.daily = { date: today, pnl: 0 };
            this.save();
        }
    }

    recordTrade(trade) {
        if (!trade) return;
        const pnl = trade.won ? (trade.profit || 0) : (trade.loss || 0);
        this.sessionPnl += pnl;
        this.rollDailyIfNeeded();
        this.daily.pnl += pnl;
        this.trades++;

        if (this.sessionPnl <= -this.sessionLossLimit) {
            this.halted = true;
            this.haltReason = `session loss limit reached (${this.sessionPnl})`;
            logger.error(`BANKROLL GUARD: ${this.haltReason} — betting blocked for this session`);
        }
        if (this.daily.pnl <= -this.dailyLossLimit) {
            this.halted = true;
            this.haltReason = `daily loss limit reached (${this.daily.pnl})`;
            logger.error(`BANKROLL GUARD: ${this.haltReason} — betting blocked until tomorrow`);
        }
        this.save();
    }

    /**
     * Caps a proposed stake by policy. Returns 0 when betting is not allowed.
     */
    /** True once a bankroll reference exists (real balance seen, or paper
     *  reference set). Live betting must never run without one. */
    hasReference() {
        return Number.isFinite(this.startingBalance) || Number.isFinite(this.balance);
    }

    approveStake(stake, tier) {
        if (this.halted || tier === 'OBSERVING') return 0;
        if (!Number.isFinite(stake) || stake <= 0) return 0;

        const bankrollRef = this.startingBalance ?? this.balance;
        // Never size blind: if no bankroll reference exists (live mode where
        // the site balance was never read), approve NOTHING. Paper mode always
        // has a reference via setPaperReference().
        if (!Number.isFinite(bankrollRef)) return 0;
        let cap = bankrollRef * this.maxStakeFraction;

        if (tier === 'MICRO') {
            const microCap = Math.max(this.minStake, bankrollRef * this.microStakeFraction);
            cap = Math.min(cap, microCap);
        }

        const approved = Math.min(stake, cap);
        if (Number.isFinite(approved) && approved < this.minStake) return 0;
        return approved;
    }

    /**
     * Final gate before a bet. Returns {allowed, reason}.
     */
    canBet(stake, balance = null) {
        if (this.halted) return { allowed: false, reason: this.haltReason };
        if (this.sessionPnl <= -this.sessionLossLimit) {
            return { allowed: false, reason: 'session loss limit reached' };
        }
        this.rollDailyIfNeeded();
        if (this.daily.pnl <= -this.dailyLossLimit) {
            return { allowed: false, reason: 'daily loss limit reached' };
        }
        if (!this.hasReference() && !Number.isFinite(balance)) {
            return { allowed: false, reason: 'no verified site balance yet — live bets need a known bankroll' };
        }
        const bal = Number.isFinite(balance) ? balance : this.balance;
        if (Number.isFinite(bal) && stake > bal) {
            return { allowed: false, reason: `stake ${stake} exceeds balance ${bal}` };
        }
        return { allowed: true, reason: 'ok' };
    }

    snapshot() {
        return {
            balance: this.balance,
            startingBalance: this.startingBalance,
            sessionPnl: this.sessionPnl,
            dailyPnl: this.daily.pnl,
            sessionLossLimit: this.sessionLossLimit,
            dailyLossLimit: this.dailyLossLimit,
            sessionLimitUsed: Number.isFinite(this.sessionLossLimit) && this.sessionLossLimit > 0
                ? Math.max(0, Math.min(1, -Math.min(0, this.sessionPnl) / this.sessionLossLimit)) : 0,
            dailyLimitUsed: Number.isFinite(this.dailyLossLimit) && this.dailyLossLimit > 0
                ? Math.max(0, Math.min(1, -Math.min(0, this.daily.pnl) / this.dailyLossLimit)) : 0,
            halted: this.halted,
            haltReason: this.haltReason,
            trades: this.trades
        };
    }
}

module.exports = Bankroll;
