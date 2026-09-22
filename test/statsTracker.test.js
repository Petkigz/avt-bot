const test = require('node:test');
const assert = require('node:assert');
const StatsTracker = require('../game/statsTracker');

test('empty stats return safe zeroes', () => {
    const t = new StatsTracker();
    const s = t.getStats();
    assert.strictEqual(s.totalTrades, 0);
    assert.strictEqual(s.winRate, 0);
    assert.strictEqual(s.netProfit, 0);
    assert.strictEqual(s.averageWin, 0);
    assert.strictEqual(s.averageLoss, 0);
});

test('records a winning trade', () => {
    const t = new StatsTracker();
    t.addTrade({ betAmount: 2, multiplier: 1.5, profit: 1, loss: 0, won: true });
    const s = t.getStats();
    assert.strictEqual(s.totalTrades, 1);
    assert.strictEqual(s.winningTrades, 1);
    assert.strictEqual(s.totalProfit, 1);
    assert.strictEqual(s.winRate, 100);
});

test('records a losing trade with negative loss', () => {
    const t = new StatsTracker();
    t.addTrade({ betAmount: 2, multiplier: 0, profit: 0, loss: -2, won: false });
    const s = t.getStats();
    assert.strictEqual(s.losingTrades, 1);
    assert.strictEqual(s.totalLoss, -2);
    assert.strictEqual(s.netProfit, -2);
});

test('netProfit combines wins and losses', () => {
    const t = new StatsTracker();
    t.addTrade({ betAmount: 2, multiplier: 1.5, profit: 1, loss: 0, won: true });
    t.addTrade({ betAmount: 2, multiplier: 0, profit: 0, loss: -2, won: false });
    const s = t.getStats();
    assert.strictEqual(s.netProfit, -1); // 1 + (-2)
});

test('tracks win and loss streaks', () => {
    const t = new StatsTracker();
    t.addTrade({ profit: 1, loss: 0, won: true });
    t.addTrade({ profit: 1, loss: 0, won: true });
    t.addTrade({ profit: 0, loss: -1, won: false });
    const s = t.getStats();
    assert.strictEqual(s.longestWinStreak, 2);
    assert.strictEqual(s.longestLossStreak, 1);
});

test('trade history is capped to avoid unbounded growth', () => {
    const t = new StatsTracker();
    for (let i = 0; i < 1100; i++) {
        t.addTrade({ profit: 1, loss: 0, won: true });
    }
    assert.ok(t.trades.length <= 1000);
    assert.strictEqual(t.getStats().totalTrades, 1100);
});
