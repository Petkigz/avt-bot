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

test('approveStake and canBet refuse to act on an unknown bankroll (live safety)', () => {
    const b = new Bankroll({ minStake: 100, maxStakeFraction: 0.02, microStakeFraction: 0.005 });
    // No setBalance, no paper reference: bankroll unknown.
    assert.strictEqual(b.hasReference(), false);
    assert.strictEqual(b.approveStake(500, 'ARMED'), 0, 'ARMED must not size blind');
    assert.strictEqual(b.approveStake(500, 'MICRO'), 0, 'MICRO must not size blind');
    const gate = b.canBet(500);
    assert.strictEqual(gate.allowed, false);
    assert.match(gate.reason, /balance|bankroll/i);
    // Paper reference (or a seen balance) restores normal sizing.
    b.setPaperReference(10000);
    assert.strictEqual(b.hasReference(), true);
    assert.ok(b.approveStake(500, 'ARMED') > 0);
});

test('bankroll reset clears a SESSION halt (2026-09-24 silent-session bug)', () => {
    const b = new Bankroll({ minStake: 100, sessionLossLimit: 1000, dailyLossLimit: 1000000 });
    b.setPaperReference(10000);
    // Bleed through the session loss limit -> guard halts.
    b.recordTrade({ won: false, loss: -1500 });
    assert.strictEqual(b.halted, true);
    assert.match(b.haltReason, /session loss limit/);
    assert.strictEqual(b.approveStake(500, 'ARMED'), 0, 'halted bankroll must refuse sizing');
    // The dashboard "reset" is a deliberate fresh session: it must clear the
    // session ledger AND the session halt, or trading stays silently dead.
    b.setPaperReference(100000);
    assert.strictEqual(b.sessionPnl, 0, 'session P/L must reset with the bankroll');
    assert.strictEqual(b.halted, false, 'session halt must clear on bankroll reset');
    assert.strictEqual(b.haltReason, null);
    assert.ok(b.approveStake(500, 'ARMED') > 0, 'sizing must resume after reset');
});

test('bankroll reset does NOT clear a DAILY loss-limit halt', () => {
    const b = new Bankroll({ minStake: 100, sessionLossLimit: 1000000, dailyLossLimit: 1000 });
    b.setPaperReference(10000);
    b.recordTrade({ won: false, loss: -1500 });
    assert.strictEqual(b.halted, true);
    assert.match(b.haltReason, /daily loss limit/);
    // A bankroll reset must not lift the date-bound daily commitment.
    b.setPaperReference(100000);
    assert.strictEqual(b.halted, true, 'daily halt must survive a bankroll reset');
    assert.match(b.haltReason, /daily loss limit/);
});
