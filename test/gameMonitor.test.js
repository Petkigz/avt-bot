const test = require('node:test');
const assert = require('node:assert');
const GameMonitor = require('../game/gameMonitor');
const Brain = require('../game/brain');
const BettingStrategy = require('../game/strategies');
const Predictor = require('../game/predictor');
const PatternDetector = require('../game/patternDetector');
const Bankroll = require('../game/bankroll');
const config = require('../util/config');

function makeBrain(strategyOverrides = {}) {
    const strategyConfig = { ...config.BETTING_STRATEGIES.MODERATE, ...strategyOverrides };
    const strategy = new BettingStrategy(strategyConfig);
    const predictor = new Predictor({
        targetMultiplier: strategyConfig.targetMultiplier,
        minSampleSize: 5,
        minEntryProbability: 0.55,
        maxEntryProbability: 0.85,
        coldStreakLimit: 3,
        coldRecoveryCount: 1
    });
    const patterns = new PatternDetector({
        lengths: [3], minSupport: 3, targetMultiplier: strategyConfig.targetMultiplier
    });
    const bankroll = new Bankroll({
        sessionLossLimit: 1000000,
        dailyLossLimit: 1000000,
        maxStakeFraction: 0.5,
        microStakeFraction: 0.1,
        minStake: strategyConfig.minBet
    });
    bankroll.setBalance(50000);
    return new Brain({ config, strategy, predictor, patterns, bankroll });
}

function makeMonitor(brain = makeBrain()) {
    const fakePage = {
        isClosed: () => false,
        reload: async () => {},
        url: () => 'https://www.betpawa.ug/virtual/aviator'
    };
    return new GameMonitor(fakePage, config, brain, {});
}

function simulateActiveBet(monitor, armed = true) {
    monitor.betManager.currentBet = {
        amount: 2,
        timestamp: Date.now(),
        targetMultiplier: 1.5,
        armed,
        settled: false,
        unarmedRoundEnds: 0,
        meta: {}
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
    // loss result queued for the martingale progression inside the Brain
    assert.deepStrictEqual(m.brain.pendingResult, { won: false });
});

test('confirmed win prevents double booking at round end', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.betManager.recordWin(1.6);

    m.onRoundEnded(1.6, null);
    const stats = m.statsTracker.getStats();
    assert.strictEqual(stats.totalTrades, 1);
    assert.strictEqual(stats.winningTrades, 1);
    assert.strictEqual(stats.losingTrades, 0);
});

test('unarmed bet survives one round end, then is booked conservatively (live mode)', () => {
    const m = makeMonitor();
    m.betManager.paperMode = false; // unarmed-ladder bookkeeping is a LIVE-mode concern
    simulateActiveBet(m, false);

    m.onRoundEnded(2.0, null);
    assert.strictEqual(m.betManager.isWaitingForResult, true);
    assert.strictEqual(m.statsTracker.getStats().totalTrades, 0);

    m.onRoundEnded(1.4, null);
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.statsTracker.getStats().losingTrades, 1);
});

test('roundEnded emits crash, prediction and stats', () => {
    const m = makeMonitor();
    let payload = null;
    m.on('roundEnded', (d) => { payload = d; });

    m.onRoundEnded(3.0, null);
    assert.ok(payload);
    assert.strictEqual(payload.crash, 3.0);
    assert.strictEqual(payload.nextPrediction, 3.0);
    assert.ok(payload.stats);
    assert.ok(payload.brain); // model/patterns/bankroll snapshot for dashboard
});

// --- Round detection hardening ---

test('jitter guard defers a bubble change that arrives too soon', () => {
    const m = makeMonitor();
    m.lastBubble = 2.0;
    m.lastRoundEndedAt = Date.now();

    const accepted = m.detectRoundEnd(1.5, null);
    assert.strictEqual(accepted, false);
    assert.strictEqual(m.lastBubble, 2.0);
});

test('jitter guard accepts the change once enough time has passed', () => {
    const m = makeMonitor();
    m.lastBubble = 2.0;
    m.lastRoundEndedAt = Date.now() - (config.GAME.MIN_ROUND_GAP_MS + 1000);

    const accepted = m.detectRoundEnd(1.5, null);
    assert.strictEqual(accepted, true);
    assert.strictEqual(m.lastBubble, 1.5);
});

test('sweep writes off a stale UNARMED bet', () => {
    const m = makeMonitor();
    simulateActiveBet(m, false);
    m.betManager.currentBet.timestamp = Date.now() - (config.GAME.BET_STALENESS_MS + 1000);

    m.sweepStaleBets();
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.statsTracker.getStats().losingTrades, 1);
});

test('sweep writes off an ARMED bet whose crash was never seen', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.betManager.currentBet.timestamp = Date.now() - (config.GAME.MAX_BET_LIFETIME_MS + 1000);

    m.sweepStaleBets();
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.betManager.currentBet, null);
});

test('flight-end grace settles an armed bet when the bubble never updates', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.flightEndedAt = Date.now() - (config.GAME.FLIGHT_END_GRACE_MS + 1000);

    m.sweepStaleBets();
    assert.strictEqual(m.betManager.isWaitingForResult, false);
    assert.strictEqual(m.statsTracker.getStats().losingTrades, 1);
});

test('every accepted round end increments the round id', () => {
    const m = makeMonitor();
    m.onRoundEnded(1.5, null);
    m.onRoundEnded(2.5, null);
    assert.strictEqual(m.roundId, 2);
});

// --- Cooldowns (safer reset logic) ---

test('cooldown counts down one round at a time', () => {
    const m = makeMonitor();
    m.enterCooldown(2, 'test reset');
    assert.strictEqual(m.cooldownRounds, 2);

    m.lastBubble = 1.0;
    m.lastRoundEndedAt = Date.now() - 5000;
    m.detectRoundEnd(2.0, null);
    assert.strictEqual(m.cooldownRounds, 1);

    m.lastRoundEndedAt = Date.now() - 5000;
    m.detectRoundEnd(3.0, null);
    assert.strictEqual(m.cooldownRounds, 0);
});

// --- Site-state recovery ladder ---

test('recovery ladder: reload -> re-navigate -> halt', async () => {
    const m = makeMonitor();
    let renavigations = 0;
    let halted = false;
    m.on('needsRenavigation', () => { renavigations++; });
    m.on('tradingStopped', () => { halted = true; });

    await m.recover();
    assert.strictEqual(m.recoveryLevel, 1);
    assert.strictEqual(m.lastBubble, null);

    await m.recover();
    assert.strictEqual(m.recoveryLevel, 2);
    assert.strictEqual(renavigations, 1);

    await m.recover();
    assert.strictEqual(m.tradingHalted, true);
    assert.strictEqual(halted, true);
    assert.match(m.haltReason, /selector failures/);
});

test('recovery enters a cooldown so we never bet mid-recovery', async () => {
    const m = makeMonitor();
    await m.recover();
    assert.ok(m.cooldownRounds >= 1);
});

// --- Wiring: paper mode + strategy identity ---

test('monitor defaults to PAPER mode (safe default)', () => {
    const m = makeMonitor();
    assert.strictEqual(config.MODE.PAPER, true);
    assert.strictEqual(m.mode(), 'paper');
    assert.strictEqual(m.betManager.paperMode, true);
});

test('monitor uses the SELECTED strategy from the brain', () => {
    const brain = makeBrain({ name: 'CONSERVATIVE', ...config.BETTING_STRATEGIES.CONSERVATIVE });
    const m = makeMonitor(brain);
    assert.strictEqual(m.strategy.name, 'CONSERVATIVE');
    assert.strictEqual(m.strategy, brain.strategy);
});

test('settled trades feed the brain (model learning + bankroll)', () => {
    const m = makeMonitor();
    simulateActiveBet(m, true);
    m.onRoundEnded(1.2, null); // armed bet loses

    assert.deepStrictEqual(m.brain.recentDecisions, [false]);
    assert.strictEqual(m.brain.predictor.settledBets.losses, 1);
    assert.strictEqual(m.brain.bankroll.sessionPnl, -2);
});

test('paper mode: bets are placed at round boundaries and settled exactly against the crash', async () => {
    const brain = makeBrain();
    const m = makeMonitor(brain);
    m.betManager.paperMode = true;

    const trades = [];
    m.on('trade', (t) => trades.push(t));

    // Warm well past OBSERVING so the paper cycle is fully active
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE + 3; i++) m.onRoundEnded(2.0, null);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(m.brain.tier, 'MICRO');
    // Drain whatever settled during warm-up; a fresh bet must be armed now
    const settled = trades.length;
    assert.ok(m.betManager.currentBet && !m.betManager.currentBet.settled,
        'a paper bet should be armed at the round boundary');

    // Next round crashes ABOVE the target -> the armed bet wins at the target
    m.onRoundEnded(2.0, null);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(trades.length, settled + 1);
    assert.strictEqual(trades[settled].won, true);
    assert.ok(trades[settled].profit > 0);

    // Next round crashes BELOW the target -> the new armed bet loses the stake
    m.onRoundEnded(1.2, null);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(trades.length, settled + 2);
    assert.strictEqual(trades[settled + 1].won, false);
    assert.ok(trades[settled + 1].loss < 0);

    // And a fresh bet is already armed for the following round
    assert.ok(m.betManager.currentBet && !m.betManager.currentBet.settled);
});

test('ADAPTIVE paper cycle: per-round model targets flow into placement and settlement', async () => {
    const brain = makeBrain({ adaptiveTarget: true, adaptiveMin: 1.3, adaptiveMax: 12 });
    const m = makeMonitor(brain);
    m.betManager.paperMode = true;

    const trades = [];
    m.on('trade', (t) => trades.push(t));

    // Warm up on a stream with a real tail, well past OBSERVING
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE + 5; i++) {
        m.onRoundEnded(i % 4 === 0 ? 5.0 : 1.35, null);
    }
    await new Promise((r) => setImmediate(r));

    const armed = m.betManager.currentBet;
    assert.ok(armed && !armed.settled, 'adaptive bet armed at the round boundary');
    assert.ok(armed.targetMultiplier >= 1.3 && armed.targetMultiplier <= 12,
        `armed target ${armed.targetMultiplier} outside adaptive bounds`);
    const target = armed.targetMultiplier;
    const settled = trades.length; // drain whatever settled during warm-up

    // Round ends ABOVE the adaptive target -> win booked AT the target
    const crash = target + 1;
    m.onRoundEnded(crash, null);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(trades.length, settled + 1);
    assert.strictEqual(trades[settled].won, true);
    assert.ok(Math.abs(trades[settled].profit - trades[settled].betAmount * (target - 1)) < 0.01,
        'win must be booked at the adaptive target, not the crash value');

    // Next armed bet may carry a DIFFERENT target (model re-picks each round)
    assert.ok(m.betManager.currentBet && !m.betManager.currentBet.settled);
});
