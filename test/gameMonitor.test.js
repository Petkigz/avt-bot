const test = require('node:test');
const assert = require('node:assert');
const GameMonitor = require('../game/gameMonitor');
const config = require('../util/config');

function makeMonitor() {
    const fakePage = { isClosed: () => false };
    return new GameMonitor(fakePage, config, { ...config.BETTING_STRATEGIES.MODERATE });
}

function simulateActiveBet(monitor, armed = true) {
    monitor.betManager.currentBet = {
        amount: 2,
        timestamp: Date.now(),
        targetMultiplier: 1.5,
        armed,
        settled: false,
        unarmedRoundEnds: 0
    };
    monitor.betManager.isWaitingForResult = true;
}

test('round end pushes the NEW crash value into history', () => {
    const m = makeMonitor();
    m.onRoundEnded(1.23, null);
    m.onRoundEnded(5.5, null);
    assert.strictEqual(m.multiplierHistory[0], 5.5);
    assert.strictEqual(m.multiplierHistory[1], 1.23);
});

test('armed bet is settled as a loss against the round that just crashed', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.onRoundEnded(1.23, null);

    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.betManager.currentBet, null);
    const stats = m.statsTracker.getStats();
    assert.strictEqual(stats.losingTrades, 1);
    assert.strictEqual(stats.totalLoss, -2);
    // loss result is queued for the martingale progression
    assert.deepStrictEqual(m.betManager.lastResult, { won: false });
});

test('loss feeds martingale: next stake doubles', () => {
    const m = makeMonitor(); // MODERATE: initial 2, multiplier 2
    simulateActiveBet(m, true);
    m.onRoundEnded(1.23, null);

    const nextStake = m.strategy.calculateNextBet(m.betManager.lastResult);
    assert.strictEqual(nextStake, 4);
});

test('confirmed win prevents double booking at round end', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.betManager.recordWin(1.6); // confirmed cashout settles the bet

    m.onRoundEnded(1.6, null); // round crashes after our cashout
    const stats = m.statsTracker.getStats();
    assert.strictEqual(stats.totalTrades, 1);
    assert.strictEqual(stats.winningTrades, 1);
    assert.strictEqual(stats.losingTrades, 0);
});

test('unarmed bet survives one round end, then is booked conservatively', () => {
    const m = makeMonitor();
    simulateActiveBet(m, false);

    m.onRoundEnded(2.0, null); // first end: give it one more round
    assert.strictEqual(m.betManager.isWaitingForResult, true);
    assert.strictEqual(m.statsTracker.getStats().totalTrades, 0);

    m.onRoundEnded(1.4, null); // second end: conservative loss
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.statsTracker.getStats().losingTrades, 1);
});

test('roundEnded emits crash, prediction and stats for the dashboard', () => {
    const m = makeMonitor();
    let payload = null;
    m.on('roundEnded', (d) => { payload = d; });

    m.onRoundEnded(3.0, null);
    assert.ok(payload);
    assert.strictEqual(payload.crash, 3.0);
    assert.strictEqual(payload.nextPrediction, 3.0);
    assert.ok(payload.stats);
});

// --- Issue: fragile round detection (DOM jitter guard) ---

test('jitter guard defers a bubble change that arrives too soon', () => {
    const m = makeMonitor();
    m.lastBubble = 2.0;
    m.lastRoundEndedAt = Date.now(); // previous round end was just now

    const accepted = m.detectRoundEnd(1.5, null);
    assert.strictEqual(accepted, false);
    assert.strictEqual(m.lastBubble, 2.0); // unchanged until confirmed
    assert.strictEqual(m.multiplierHistory.length, 0);
});

test('jitter guard accepts the change once enough time has passed', () => {
    const m = makeMonitor();
    m.lastBubble = 2.0;
    m.lastRoundEndedAt = Date.now() - (config.GAME.MIN_ROUND_GAP_MS + 1000);

    const accepted = m.detectRoundEnd(1.5, null);
    assert.strictEqual(accepted, true);
    assert.strictEqual(m.lastBubble, 1.5);
    assert.strictEqual(m.multiplierHistory[0], 1.5);
});

// --- Issue: bet state can get stuck ---

test('sweep writes off a stale UNARMED bet', () => {
    const m = makeMonitor();
    simulateActiveBet(m, false);
    m.betManager.currentBet.timestamp = Date.now() - (config.GAME.BET_STALENESS_MS + 1000);

    m.sweepStaleBets();
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.statsTracker.getStats().losingTrades, 1);
});

test('sweep writes off an ARMED bet whose crash was never seen (loop never blocks)', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.betManager.currentBet.timestamp = Date.now() - (config.GAME.MAX_BET_LIFETIME_MS + 1000);

    m.sweepStaleBets();
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.betManager.currentBet, null);
});

test('sweep leaves a fresh bet alone', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.sweepStaleBets();
    assert.strictEqual(m.betManager.isWaitingForResult, true);
});

// --- Issue: empty-history NaN ---

test('average of empty history is Infinity, never NaN', () => {
    const m = makeMonitor();
    const avg = m.average([]);
    assert.strictEqual(Number.isNaN(avg), false);
    assert.strictEqual(avg, Infinity);
    // Infinity <= threshold is false -> the bot simply does not bet.
    assert.strictEqual(avg <= m.strategy.averageMultiplierThreshold, false);
});

// --- Issue: selected strategy must actually be honored ---

test('monitor uses the SELECTED strategy, not a hardcoded one', () => {
    const fakePage = { isClosed: () => false };
    const m = new GameMonitor(fakePage, config, { ...config.BETTING_STRATEGIES.CONSERVATIVE });
    assert.strictEqual(m.strategy.name, 'CONSERVATIVE');
    assert.strictEqual(m.betManager.strategy, m.strategy); // same instance
    assert.strictEqual(m.strategy.targetMultiplier, config.BETTING_STRATEGIES.CONSERVATIVE.targetMultiplier);
});
