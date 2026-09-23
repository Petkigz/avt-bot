const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Bankroll = require('../game/bankroll');

function makeBankroll(overrides = {}) {
    const b = new Bankroll({
        sessionLossLimit: 5000,
        dailyLossLimit: 10000,
        maxStakeFraction: 0.02,
        microStakeFraction: 0.005,
        minStake: 100,
        ...overrides
    });
    b.setBalance(50000);
    return b;
}

test('approveStake caps ARMED stakes at the bankroll fraction', () => {
    const b = makeBankroll();
    assert.strictEqual(b.approveStake(100000, 'ARMED'), 50000 * 0.02); // 1000
    assert.strictEqual(b.approveStake(500, 'ARMED'), 500); // below cap unchanged
});

test('approveStake caps MICRO stakes at the micro fraction', () => {
    const b = makeBankroll();
    const microCap = Math.max(100, 50000 * 0.005); // 250
    assert.strictEqual(b.approveStake(100000, 'MICRO'), microCap);
});

test('approveStake returns 0 while OBSERVING or halted', () => {
    const b = makeBankroll();
    assert.strictEqual(b.approveStake(500, 'OBSERVING'), 0);
    b.halted = true;
    assert.strictEqual(b.approveStake(500, 'ARMED'), 0);
});

test('session loss limit halts betting', () => {
    const b = makeBankroll({ sessionLossLimit: 1000 });
    b.recordTrade({ won: false, loss: -1200, profit: 0 });
    assert.strictEqual(b.halted, true);
    assert.match(b.haltReason, /session loss limit/);
    assert.strictEqual(b.canBet(100).allowed, false);
});

test('daily loss limit halts betting and persists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bankroll-'));
    const file = path.join(dir, 'bankroll.json');
    const b = Bankroll.load(file, { sessionLossLimit: 100000, dailyLossLimit: 1000, minStake: 100 });
    b.setBalance(50000);
    b.recordTrade({ won: false, loss: -1500, profit: 0 });
    assert.strictEqual(b.halted, true);
    assert.match(b.haltReason, /daily loss limit/);

    // Persists across restart (same day)
    const b2 = Bankroll.load(file, { sessionLossLimit: 100000, dailyLossLimit: 1000, minStake: 100 });
    assert.strictEqual(b2.daily.pnl, -1500);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('stake above balance is refused', () => {
    const b = makeBankroll();
    const res = b.canBet(60000, 50000);
    assert.strictEqual(res.allowed, false);
    assert.match(res.reason, /exceeds balance/);
});

test('winning trades accumulate positive P/L', () => {
    const b = makeBankroll();
    b.recordTrade({ won: true, profit: 300, loss: 0 });
    b.recordTrade({ won: false, profit: 0, loss: -100 });
    assert.strictEqual(b.sessionPnl, 200);
    assert.strictEqual(b.daily.pnl, 200);
});

test('snapshot exposes limit usage for the dashboard', () => {
    const b = makeBankroll({ sessionLossLimit: 1000 });
    b.recordTrade({ won: false, loss: -500, profit: 0 });
    const s = b.snapshot();
    assert.strictEqual(s.sessionLimitUsed, 0.5);
    assert.strictEqual(s.halted, false);
    assert.strictEqual(s.trades, 1);
});

test('paper reference bankroll ignores the real account balance', () => {
    const b = new Bankroll({ minStake: 100 });
    b.setBalance(20.82);
    assert.strictEqual(b.balance, 20.82);
    b.setPaperReference(10000);
    assert.strictEqual(b.balance, 10000);
    assert.strictEqual(b.startingBalance, 10000);
    // A real balance read must not clobber the simulated bankroll
    b.setBalance(20.82);
    assert.strictEqual(b.balance, 10000);
    // Stake sized against paper capital passes the balance gate
    assert.strictEqual(b.canBet(100).allowed, true);
});
