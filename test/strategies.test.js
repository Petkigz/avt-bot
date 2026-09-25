const test = require('node:test');
const assert = require('node:assert');
const BettingStrategy = require('../game/strategies');

const base = {
    name: 'TEST',
    initialBet: 2,
    maxBet: 100,
    minBet: 1,
    targetMultiplier: 1.5,
    stopLoss: 50,
    takeProfit: 100,
    martingaleMultiplier: 2,
    averageMultiplierThreshold: 2
};

test('calculateNextBet returns initial bet with no prior result', () => {
    const s = new BettingStrategy(base);
    assert.strictEqual(s.calculateNextBet(), 2);
});

test('martingale doubles after a loss and resets after a win', () => {
    const s = new BettingStrategy(base);
    assert.strictEqual(s.calculateNextBet({ won: false }), 4);  // 2 * 2
    assert.strictEqual(s.calculateNextBet({ won: false }), 8);  // 4 * 2
    assert.strictEqual(s.calculateNextBet({ won: true }), 2);   // reset
});

test('martingale respects maxBet cap', () => {
    const s = new BettingStrategy({ ...base, maxBet: 10 });
    s.calculateNextBet({ won: false }); // 4
    s.calculateNextBet({ won: false }); // 8
    const capped = s.calculateNextBet({ won: false }); // 16 -> capped to 10
    assert.strictEqual(capped, 10);
});

test('bet never drops below minBet', () => {
    const s = new BettingStrategy({ ...base, minBet: 5, initialBet: 2 });
    assert.ok(s.calculateNextBet() >= 5);
});

test('calling calculateNextBet(null) again keeps progressed amount (retry-safe)', () => {
    const s = new BettingStrategy(base);
    const first = s.calculateNextBet({ won: false }); // 4
    const retry = s.calculateNextBet(null);           // still 4
    assert.strictEqual(first, retry);
});

test('shouldStopTrading on stop-loss', () => {
    const s = new BettingStrategy(base); // stopLoss: 50, takeProfit: 100
    assert.strictEqual(s.shouldStopTrading({ totalLoss: -50, totalProfit: 0 }), true);
    assert.strictEqual(s.shouldStopTrading({ totalLoss: -49, totalProfit: 0 }), false);
    // In net profit (below takeProfit), even with gross losses > stopLoss, stopLoss should NOT trigger
    assert.strictEqual(s.shouldStopTrading({ totalLoss: -15000, totalProfit: 15020, netProfit: 20 }), false);
    // In net loss >= stopLoss, stopLoss triggers
    assert.strictEqual(s.shouldStopTrading({ totalLoss: -15050, totalProfit: 15000, netProfit: -50 }), true);
});

test('shouldStopTrading on take-profit', () => {
    const s = new BettingStrategy(base);
    assert.strictEqual(s.shouldStopTrading({ totalLoss: 0, totalProfit: 100 }), true);
    assert.strictEqual(s.shouldStopTrading({ totalLoss: 0, totalProfit: 99 }), false);
    // High turnover without net profit should NOT trigger take-profit
    assert.strictEqual(s.shouldStopTrading({ totalLoss: -1000, totalProfit: 1050, netProfit: 50 }), false);
    // Net profit reaching takeProfit triggers
    assert.strictEqual(s.shouldStopTrading({ totalLoss: -500, totalProfit: 600, netProfit: 100 }), true);
});

test('shouldStopTrading on 5 consecutive losses', () => {
    const s = new BettingStrategy(base);
    for (let i = 0; i < 5; i++) s.recordResult({ won: false });
    assert.strictEqual(s.shouldStopTrading({ totalLoss: 0, totalProfit: 0 }), true);
});

test('averageMultiplierThreshold falls back to targetMultiplier', () => {
    const s = new BettingStrategy({ ...base, averageMultiplierThreshold: undefined });
    assert.strictEqual(s.averageMultiplierThreshold, base.targetMultiplier);
});

test('validate accepts a good config', () => {
    const { ok } = BettingStrategy.validate(base);
    assert.strictEqual(ok, true);
});

test('validate rejects invalid configs', () => {
    const bad = { ...base, minBet: 200, maxBet: 100 };
    const { ok, errors } = BettingStrategy.validate(bad);
    assert.strictEqual(ok, false);
    assert.ok(errors.length > 0);
});

test('validate rejects NaN fields', () => {
    const bad = { ...base, initialBet: NaN };
    const { ok } = BettingStrategy.validate(bad);
    assert.strictEqual(ok, false);
});

test('loss-streak breaker is configurable', () => {
    const s = new BettingStrategy({ ...base, maxConsecutiveLosses: 3 });
    s.recordResult({ won: false });
    s.recordResult({ won: false });
    assert.strictEqual(s.shouldStopTrading({ totalLoss: 0, totalProfit: 0 }), false);
    s.recordResult({ won: false });
    assert.strictEqual(s.shouldStopTrading({ totalLoss: 0, totalProfit: 0 }), true);
});

test('resetProgression returns stake to initial but keeps the loss counters', () => {
    const s = new BettingStrategy(base);
    s.recordResult({ won: false }); // currentBet -> 4
    s.recordResult({ won: false }); // currentBet -> 8
    assert.strictEqual(s.consecutiveLosses, 2);

    s.resetProgression();
    assert.strictEqual(s.getNextBetAmount(), base.initialBet); // restart small
    assert.strictEqual(s.consecutiveLosses, 2); // breaker NOT evaded
    assert.strictEqual(s.shouldStopTrading({ totalLoss: 0, totalProfit: 0 }), false);
});

test('validate rejects a bad maxConsecutiveLosses', () => {
    const bad = { ...base, maxConsecutiveLosses: 0 };
    const { ok } = BettingStrategy.validate(bad);
    assert.strictEqual(ok, false);
});
