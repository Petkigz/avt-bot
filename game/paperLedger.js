'use strict';

const fs = require('fs');
const path = require('path');

const r2 = (x) => Number(x.toFixed(2));

/**
 * PaperLedger — a persistent profit/loss book.
 *
 * Two uses:
 *  1. SIMULATION (kind 'sim'): created with capital + stake + target, then
 *     playRound(crash) is called for EVERY round — "what if the bet had
 *     actually happened". This powers the paper-mode Profits panel.
 *  2. TRADE LOG (kind 'log'): created empty; recordTrade() appends real or
 *     engine-approved simulated trades as they occur.
 *
 * Everything persists, so the P&L survives restarts. The balance curve is
 * capped at the most recent `curveCap` points for charting.
 */
class PaperLedger {
    constructor(file, opts = {}) {
        this.file = file;
        this.kind = opts.kind || (opts.capital > 0 ? 'sim' : 'log');
        this.capital = opts.capital || 0;
        this.stake = opts.stake || 0;
        this.target = opts.target || 1.3;
        this.curveCap = opts.curveCap || 500;
        this.reset(this.capital, this.stake, this.target, { persist: false });
    }

    reset(capital = this.capital, stake = this.stake, target = this.target, opts = {}) {
        this.capital = capital;
        this.stake = stake;
        this.target = target;
        this.balance = capital;
        this.bets = 0;
        this.wins = 0;
        this.losses = 0;
        this.skipped = 0;
        this.pnl = 0;
        this.peak = 0;
        this.maxDrawdown = 0;
        this.curve = [r2(capital)];
        this.startedAt = null;
        this.lastRoundAt = null;
        if (opts.persist !== false) this.save();
    }

    load() {
        try {
            if (!fs.existsSync(this.file)) return false;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (!raw || typeof raw !== 'object') return false;
            this.capital = Number(raw.capital) || 0;
            this.stake = Number(raw.stake) || 0;
            this.target = Number(raw.target) || this.target;
            this.balance = Number.isFinite(raw.balance) ? raw.balance : this.capital;
            this.bets = raw.bets | 0;
            this.wins = raw.wins | 0;
            this.losses = raw.losses | 0;
            this.skipped = raw.skipped | 0;
            this.pnl = Number.isFinite(raw.pnl) ? raw.pnl : this.balance - this.capital;
            this.peak = Number(raw.peak) || 0;
            this.maxDrawdown = Number(raw.maxDrawdown) || 0;
            this.curve = Array.isArray(raw.curve) ? raw.curve.filter(Number.isFinite) : [r2(this.capital)];
            this.startedAt = raw.startedAt || null;
            this.lastRoundAt = raw.lastRoundAt || null;
            return true;
        } catch (error) {
            return false;
        }
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify({
                kind: this.kind, capital: this.capital, stake: this.stake, target: this.target,
                balance: r2(this.balance), bets: this.bets, wins: this.wins, losses: this.losses,
                skipped: this.skipped, pnl: r2(this.pnl), peak: r2(this.peak),
                maxDrawdown: r2(this.maxDrawdown), curve: this.curve,
                startedAt: this.startedAt, lastRoundAt: this.lastRoundAt
            }));
            return true;
        } catch (error) {
            return false;
        }
    }

    /** Simulate a flat-stake bet at `target` on this round's crash value. */
    playRound(crash) {
        if (!Number.isFinite(crash) || crash <= 0 || this.stake <= 0) return null;
        if (this.balance < this.stake) {
            this.skipped += 1;
            this.lastRoundAt = Date.now();
            return { skipped: true, reason: 'insufficient simulated balance', balance: r2(this.balance) };
        }
        const won = crash >= this.target;
        const pnl = won ? this.stake * (this.target - 1) : -this.stake;
        return this._apply(won, pnl, crash);
    }

    /** Record an actual (or engine-approved simulated) trade. */
    recordTrade({ stake = 0, pnl, won }) {
        if (!Number.isFinite(pnl)) return null;
        return this._apply(won === true, pnl, null);
    }

    _apply(won, pnl, crash) {
        this.balance += pnl;
        this.pnl += pnl;
        this.bets += 1;
        if (won) this.wins += 1; else this.losses += 1;
        const net = this.balance - this.capital;
        if (net > this.peak) this.peak = net;
        const dd = this.peak - net;
        if (dd > this.maxDrawdown) this.maxDrawdown = dd;
        this.curve.push(r2(this.balance));
        while (this.curve.length > this.curveCap) this.curve.shift();
        const now = Date.now();
        if (!this.startedAt) this.startedAt = now;
        this.lastRoundAt = now;
        this.save();
        return { won, pnl: r2(pnl), balance: r2(this.balance), crash };
    }

    stats() {
        return {
            kind: this.kind,
            capital: r2(this.capital),
            stake: r2(this.stake),
            target: this.target,
            balance: r2(this.balance),
            pnl: r2(this.balance - this.capital),
            bets: this.bets,
            wins: this.wins,
            losses: this.losses,
            skipped: this.skipped,
            winRate: this.bets > 0 ? r2((this.wins / this.bets) * 100) : null,
            peak: r2(this.peak),
            maxDrawdown: r2(this.maxDrawdown),
            curve: this.curve
        };
    }
}

module.exports = PaperLedger;
