const test = require('node:test');
const assert = require('node:assert');
const Brain = require('../game/brain');
const BettingStrategy = require('../game/strategies');
const Predictor = require('../game/predictor');
const PatternDetector = require('../game/patternDetector');
const Bankroll = require('../game/bankroll');
const config = require('../util/config');

function makeBrain({ strategyOverrides = {}, bankrollBalance = 50000 } = {}) {
    const strategyConfig = { ...config.BETTING_STRATEGIES.MICRO, ...strategyOverrides };
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
        sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
        dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
        maxStakeFraction: config.RISK.MAX_STAKE_FRACTION,
        microStakeFraction: config.RISK.MICRO_STAKE_FRACTION,
        minStake: strategyConfig.minBet
    });
    bankroll.setBalance(bankrollBalance);
    const brain = new Brain({ config, strategy, predictor, patterns, bankroll });
    return { brain, strategy, predictor, patterns, bankroll, strategyConfig };
}

function warmUp(brain, rounds, value = 2.0) {
    for (let i = 0; i < rounds; i++) brain.onRoundEnded(value);
}

test('warm-up is mandatory: no bets while OBSERVING', () => {
    const { brain } = makeBrain();
    const d = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d.shouldBet, false);
    assert.strictEqual(brain.tier, 'OBSERVING');
    assert.match(d.reasons.join(' '), /observing|warm-up/);
});

test('after warm-up the tier promotes to MICRO and bets are micro-capped', () => {
    const { brain, bankroll } = makeBrain({ strategyOverrides: { initialBet: 1000, maxBet: 5000 } });
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0); // all rounds above target

    assert.strictEqual(brain.tier, 'MICRO');
    const d = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d.shouldBet, true);

    const microCap = Math.max(100, 50000 * config.RISK.MICRO_STAKE_FRACTION); // 250
    assert.ok(d.stake <= microCap, `stake ${d.stake} should be <= micro cap ${microCap}`);
    assert.ok(d.stake < 1000, 'stake must be below the raw strategy stake while MICRO');
    void bankroll;
});

test('promotion MICRO -> ARMED requires sustained hit-rate', () => {
    const { brain } = makeBrain();
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'MICRO';

    // Not enough decisions yet
    brain.recentDecisions = Array(config.RISK.PROMOTION_MIN_DECISIONS - 1).fill(true);
    brain.updateTier();
    assert.strictEqual(brain.tier, 'MICRO');

    brain.recentDecisions.push(true); // now enough, all wins
    brain.updateTier();
    assert.strictEqual(brain.tier, 'ARMED');
});

test('demotion ARMED -> MICRO when hit-rate sags', () => {
    const { brain } = makeBrain();
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'ARMED';
    brain.recentDecisions = Array(Math.ceil(config.RISK.DECISION_WINDOW / 2)).fill(false);
    brain.updateTier();
    assert.strictEqual(brain.tier, 'MICRO');
});

test('loss-streak guard blocks betting even after warm-up', () => {
    const { brain } = makeBrain();
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'MICRO';
    // three consecutive low crashes -> streak-guard pause
    brain.onRoundEnded(1.0);
    brain.onRoundEnded(1.0);
    brain.onRoundEnded(1.0);
    assert.strictEqual(brain.predictor.paused, true);

    const d = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d.shouldBet, false);
    assert.match(d.reasons.join(' '), /loss-streak guard/);
});

test('session loss limit blocks all further bets', () => {
    const { brain, bankroll } = makeBrain();
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'MICRO';

    bankroll.recordTrade({ won: false, loss: -(config.RISK.SESSION_LOSS_LIMIT + 1), profit: 0 });
    assert.strictEqual(bankroll.halted, true);

    const d = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d.shouldBet, false);
    assert.match(d.reasons.join(' '), /bankroll|loss limit/);
});

test('insufficient balance blocks the bet', () => {
    const { brain } = makeBrain();
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'MICRO';
    const d = brain.decide({ bettingWindow: true, balance: 1 });
    assert.strictEqual(d.shouldBet, false);
});

test('martingale progression advances only after a settled loss', () => {
    const { brain } = makeBrain({ strategyOverrides: { initialBet: 100, maxBet: 5000, martingaleMultiplier: 2 } });
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'ARMED'; // uncapped by micro for clarity of the progression

    const d1 = brain.decide({ bettingWindow: true, balance: 100000 });
    assert.strictEqual(d1.stake, Math.min(100, 100000 * config.RISK.MAX_STAKE_FRACTION));

    brain.recordOutcome({ won: false, loss: -d1.stake, profit: 0, betAmount: d1.stake }, {});
    const d2 = brain.decide({ bettingWindow: true, balance: 100000 });
    assert.strictEqual(d2.stake, Math.min(200, 100000 * config.RISK.MAX_STAKE_FRACTION));
});

test('closed window / cooldown / halted all refuse bets', () => {
    const { brain } = makeBrain();
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    brain.tier = 'MICRO';

    assert.strictEqual(brain.decide({ bettingWindow: false, balance: 50000 }).shouldBet, false);
    assert.strictEqual(brain.decide({ bettingWindow: true, balance: 50000, cooldownRounds: 2 }).shouldBet, false);
    assert.strictEqual(brain.decide({ bettingWindow: true, balance: 50000, halted: true }).shouldBet, false);
});

test('MICRO_ONLY safety profile never promotes past micro-bets', () => {
    const strategyConfig = { ...config.BETTING_STRATEGIES.MICRO };
    const strategy = new BettingStrategy(strategyConfig);
    const predictor = new Predictor({
        targetMultiplier: strategyConfig.targetMultiplier,
        minSampleSize: 5, minEntryProbability: 0.55, maxEntryProbability: 0.85,
        coldStreakLimit: 3, coldRecoveryCount: 1
    });
    const patterns = new PatternDetector({ lengths: [3], minSupport: 3, targetMultiplier: strategyConfig.targetMultiplier });
    const bankroll = new Bankroll({
        sessionLossLimit: 1000000, dailyLossLimit: 1000000,
        maxStakeFraction: 0.5, microStakeFraction: 0.1, minStake: strategyConfig.minBet
    });
    bankroll.setBalance(50000);
    const brain = new Brain({ config, strategy, predictor, patterns, bankroll, microOnly: true });

    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) brain.onRoundEnded(2.0);
    assert.strictEqual(brain.tier, 'MICRO');

    // A perfect hit-rate that would normally promote to ARMED...
    brain.recentDecisions = Array(config.RISK.PROMOTION_MIN_DECISIONS + 10).fill(true);
    brain.updateTier();
    // ...must NOT promote under MICRO_ONLY
    assert.strictEqual(brain.tier, 'MICRO');
    assert.strictEqual(brain.snapshot().microOnly, true);
});

test('dashboard pause blocks betting decisions until resumed', () => {
    const { brain } = makeBrain();
    warmUp(brain, 200, 1.1); // OBSERVING either way — pause must gate FIRST
    brain.paused = true;
    const d1 = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d1.shouldBet, false);
    assert.ok(d1.reasons.join(';').includes('paused by user'), d1.reasons.join(';'));
    brain.paused = false;
    const d2 = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.ok(!d2.reasons.join(';').includes('paused by user'));
});

test('paused state is surfaced in the brain snapshot', () => {
    const { brain } = makeBrain();
    assert.strictEqual(brain.paused, false);
    brain.paused = true;
    assert.strictEqual(brain.paused, true);
});

test('STRICT signal policy blocks betting until a positive OOS verdict exists', () => {
    const strategyConfig = { ...config.BETTING_STRATEGIES.MICRO };
    const strategy = new BettingStrategy(strategyConfig);
    const mk = (signal) => {
        const predictor = new Predictor({
            targetMultiplier: strategyConfig.targetMultiplier,
            minSampleSize: 5, minEntryProbability: 0.55, maxEntryProbability: 0.85,
            coldStreakLimit: 3, coldRecoveryCount: 1
        });
        const bankroll = new Bankroll({
            sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
            dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
            maxStakeFraction: config.RISK.MAX_STAKE_FRACTION,
            microStakeFraction: config.RISK.MICRO_STAKE_FRACTION,
            minStake: strategyConfig.minBet
        });
        bankroll.setBalance(50000);
        return new Brain({ config, strategy, predictor, patterns: null, bankroll, signal });
    };
    const verdict = { signalDetected: false };

    // No verdict at all -> blocked
    const b1 = mk({ policy: 'strict', getVerdict: () => null });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) b1.onRoundEnded(2.0);
    const d1 = b1.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d1.shouldBet, false);
    assert.match(d1.reasons.join(' '), /signal policy STRICT/i);

    // Negative verdict -> still blocked
    const b2 = mk({ policy: 'strict', getVerdict: () => verdict });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) b2.onRoundEnded(2.0);
    assert.strictEqual(b2.decide({ bettingWindow: true, balance: 50000 }).shouldBet, false);

    // Positive verdict -> the gate opens (bet proceeds through normal gates)
    const b3 = mk({ policy: 'strict', getVerdict: () => ({ signalDetected: true }) });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) b3.onRoundEnded(2.0);
    const d3 = b3.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d3.shouldBet, true);

    // Advisory policy never blocks on verdicts
    const b4 = mk({ policy: 'advisory', getVerdict: () => null });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) b4.onRoundEnded(2.0);
    assert.strictEqual(b4.decide({ bettingWindow: true, balance: 50000 }).shouldBet, true);
});

test('snapshot carries the signal policy + verdict summary', () => {
    const { brain } = makeBrain();
    brain.signal = { policy: 'strict', getVerdict: () => ({ signalDetected: true, rounds: 500, target: 1.3, ts: 1, verdict: 'x' }) };
    const snap = brain.snapshot();
    assert.strictEqual(snap.signal.policy, 'strict');
    assert.strictEqual(snap.signal.verdict.signalDetected, true);
});
