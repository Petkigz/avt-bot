'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PaperLedger = require('../game/paperLedger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avt-ledger-'));

test('simulates every round at flat stake and target', () => {
    const l = new PaperLedger(path.join(tmp(), 'l.json'), { capital: 1000, stake: 100, target: 1.3 });
    let r = l.playRound(2.0);   // win: +100*(1.3-1) = +30
    assert.equal(r.won, true);
    assert.equal(r.pnl, 30);
    assert.equal(l.balance, 1030);

    r = l.playRound(1.1);       // loss: -100
    assert.equal(r.won, false);
    assert.equal(r.pnl, -100);
    assert.equal(l.balance, 930);

    r = l.playRound(1.3);       // exactly at target counts as a win
    assert.equal(r.won, true);
    assert.equal(l.balance, 960);

    const s = l.stats();
    assert.equal(s.bets, 3);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.equal(s.pnl, -40);
    assert.ok(Math.abs(s.winRate - 66.67) < 0.01);
});

test('skips bets when the simulated balance cannot cover the stake', () => {
    const l = new PaperLedger(path.join(tmp(), 'l.json'), { capital: 150, stake: 100, target: 1.3 });
    l.playRound(1.0); // loss -> balance 50
    const r = l.playRound(2.0);
    assert.equal(r.skipped, true);
    assert.equal(l.balance, 50);
    assert.equal(l.stats().skipped, 1);
});

test('tracks peak profit and max drawdown', () => {
    const l = new PaperLedger(path.join(tmp(), 'l.json'), { capital: 1000, stake: 100, target: 2 });
    l.playRound(3);  // +100 (net +100, peak 100)
    l.playRound(1);  // -100 (net 0)
    l.playRound(1);  // -100 (net -100 -> drawdown from peak = 200)
    const s = l.stats();
    assert.equal(s.peak, 100);
    assert.equal(s.maxDrawdown, 200);
});

test('persists across restarts', () => {
    const file = path.join(tmp(), 'persist.json');
    const a = new PaperLedger(file, { capital: 500, stake: 50, target: 1.5 });
    a.playRound(2);
    a.playRound(1);
    const b = new PaperLedger(file);
    assert.equal(b.load(), true);
    assert.equal(b.balance, a.balance);
    assert.equal(b.bets, 2);
    assert.equal(b.capital, 500);
    assert.deepEqual(b.curve, a.curve);
});

test('reset returns to fresh capital', () => {
    const l = new PaperLedger(path.join(tmp(), 'l.json'), { capital: 1000, stake: 100, target: 1.3 });
    l.playRound(1.0);
    l.reset(2000, 200, 1.5);
    assert.equal(l.balance, 2000);
    assert.equal(l.bets, 0);
    assert.equal(l.curve.length, 1);
});

test('trade-log ledgers record engine/live trades', () => {
    const l = new PaperLedger(path.join(tmp(), 'l.json'), { kind: 'log' });
    l.recordTrade({ stake: 100, pnl: 30, won: true });
    l.recordTrade({ stake: 100, pnl: -100, won: false });
    const s = l.stats();
    assert.equal(s.capital, 0);
    assert.equal(s.pnl, -70);
    assert.equal(s.balance, -70);
    assert.equal(s.bets, 2);
    assert.equal(l.recordTrade({ pnl: NaN }), null);
});

test('curve is capped for charting', () => {
    const l = new PaperLedger(path.join(tmp(), 'l.json'), { capital: 1e9, stake: 1, target: 1.3, curveCap: 20 });
    for (let i = 0; i < 50; i++) l.playRound(2);
    assert.equal(l.curve.length, 20);
});
