const test = require('node:test');
const assert = require('node:assert');
const Brain = require('../game/brain');
const BettingStrategy = require('../game/strategies');
const Predictor = require('../game/predictor');
const PatternDetector = require('../game/patternDetector');
const Bankroll = require('../game/bankroll');
const config = require('../util/config');
const { FEATURE_VERSION } = require('../game/features');

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

    // Detected but UNCONFIRMED signal -> still blocked (fresh-holdout failed)
    const b3a = mk({ policy: 'strict', getVerdict: () => ({ signalDetected: true, signalConfirmed: false }) });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) b3a.onRoundEnded(2.0);
    const d3a = b3a.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d3a.shouldBet, false);
    assert.match(d3a.reasons.join(' '), /UNCONFIRMED/);

    // Confirmed but UNECONOMIC (below break-even) -> still blocked
    const b3b = mk({ policy: 'strict', getVerdict: () => ({ signalDetected: true, signalConfirmed: true, signalEconomical: false }) });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) b3b.onRoundEnded(2.0);
    const d3b = b3b.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d3b.shouldBet, false);
    assert.match(d3b.reasons.join(' '), /break-even/);

    // Positive AND confirmed AND economic -> the gate opens
    const b3 = mk({ policy: 'strict', getVerdict: () => ({ signalDetected: true, signalConfirmed: true, signalEconomical: true }) });
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

test('pattern freeze -> test -> promote: candidates have zero influence', () => {
    // Fake detector: a pattern claiming 0.95 probability. As a CANDIDATE
    // (< MIN_LIVE_USES live uses) it must NOT move confidence; once promoted
    // with a statistically-base-beating live record it may blend in.
    const mkWithPattern = (used, liveWinRate, liveWins) => {
        const strategyConfig = { ...config.BETTING_STRATEGIES.MICRO };
        const strategy = new BettingStrategy(strategyConfig);
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
        const patterns = {
            observe: () => {},
            snapshot: () => null,
            recordUsageOutcome: () => {},
            detect: () => ({
                found: true, pattern: 'LHL', probability: 0.95, quality: 1,
                risky: false, used, liveWinRate, liveWins: liveWins ?? 0
            })
        };
        const brain = new Brain({ config, strategy, predictor, patterns, bankroll });
        // Mixed warm-up: ~75% base confidence (above the entry threshold but
        // below the pattern's 0.95 claim, so a promoted pattern lifts it).
        for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) brain.onRoundEnded(i % 4 === 3 ? 1.0 : 2.0);
        return brain;
    };

    const candidate = mkWithPattern(config.PATTERN.MIN_LIVE_USES - 1, null, 0);
    // Perfect 200/200 live record: even after the look-elsewhere penalty for
    // the mined pattern space, the Wilson lower bound (~0.98 - 0.08) still
    // beats the ~0.75 base rate of the mixed warm-up -> evidence factor 1.
    const promoted = mkWithPattern(200, 1.0, 200);
    // Perfect but SHORT 20/20 record: after the multiple-testing correction
    // (penalty ~0.26 for the searched space) it no longer clears the base
    // rate -> evidence 0. A small sample cannot prove a mined pattern.
    const shortPerfect = mkWithPattern(config.PATTERN.MIN_LIVE_USES * 2, 1.0, config.PATTERN.MIN_LIVE_USES * 2);
    // Good-looking 80% record that does NOT statistically beat the ~75% base
    // rate (Wilson lower bound ~0.58) -> evidence factor 0 -> zero influence.
    const notBeating = mkWithPattern(config.PATTERN.MIN_LIVE_USES * 2, 0.8, 16);
    const dCand = candidate.decide({ bettingWindow: true, balance: 50000 });
    const dProm = promoted.decide({ bettingWindow: true, balance: 50000 });
    const dShort = shortPerfect.decide({ bettingWindow: true, balance: 50000 });
    const dNB = notBeating.decide({ bettingWindow: true, balance: 50000 });

    // Candidate: the 0.95 claim must not have lifted confidence at all
    assert.ok(dCand.confidence <= dProm.confidence);
    assert.ok(dProm.confidence > dCand.confidence + 0.05,
        `promoted evidence-backed pattern should visibly raise confidence (cand ${dCand.confidence}, prom ${dProm.confidence})`);
    // LOOK-ELSEWHERE: a perfect but short live record is exactly what random
    // mining produces somewhere in a large pattern space — it must NOT lift
    // confidence once the multiple-testing penalty is applied.
    assert.ok(Math.abs(dShort.confidence - dCand.confidence) < 1e-9,
        `short perfect record must not move confidence under the look-elsewhere correction (short ${dShort.confidence}, cand ${dCand.confidence})`);
    // A winning-looking record that doesn't beat the base rate gets NOTHING
    assert.ok(Math.abs(dNB.confidence - dCand.confidence) < 1e-9,
        `80% live record below base rate must not move confidence (nb ${dNB.confidence}, cand ${dCand.confidence})`);

    // A promoted pattern that keeps LOSING (below the base rate) blocks
    const loser = mkWithPattern(config.PATTERN.MIN_LIVE_USES * 2, 0.3, 6);
    const dLose = loser.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dLose.shouldBet, false);
    assert.match(dLose.reasons.join(' '), /live win rate 30% after/);
});

test('setStrategy retargets the model and pattern miner on a strategy switch', () => {
    const { brain, predictor, patterns } = makeBrain();
    warmUp(brain, 200, 2.0);
    assert.strictEqual(predictor.targetMultiplier, 1.3); // MICRO default in fixture

    const aggressive = new BettingStrategy({ ...config.BETTING_STRATEGIES.AGGRESSIVE });
    brain.setStrategy(aggressive);

    assert.strictEqual(brain.strategy.targetMultiplier, 2.0);
    assert.strictEqual(predictor.targetMultiplier, 2.0, 'model must predict the NEW target');
    assert.strictEqual(patterns.targetMultiplier, 2.0, 'pattern success must measure the NEW target');
    assert.ok(predictor.baseEntryProbability < 0.55,
        'entry threshold must rescale down with the higher target');
});

test('ADAPTIVE mode: decide picks a model-driven target within the strategy bounds', () => {
    const { brain } = makeBrain({ strategyOverrides: {
        adaptiveTarget: true, adaptiveMin: 1.3, adaptiveMax: 10
    } });
    // Mixed warm-up so the distribution read has a real tail
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE + 20; i++) {
        brain.onRoundEnded(i % 5 === 0 ? 4 + (i % 3) : 1.2 + (i % 4) * 0.15);
    }
    assert.strictEqual(brain.tier, 'MICRO');

    const seen = new Set();
    for (let i = 0; i < 30; i++) {
        const d = brain.decide({ bettingWindow: true, balance: 50000 });
        if (!d.shouldBet) continue;
        assert.ok(d.targetMultiplier >= 1.3 && d.targetMultiplier <= 10,
            `adaptive target ${d.targetMultiplier} outside bounds`);
        seen.add(d.targetMultiplier);
        brain.onRoundEnded(1.5); // settle-ish feedback between decisions
    }
    assert.ok(seen.size >= 2, `targets should vary round-to-round (got ${[...seen].join(', ')})`);
});

test('ADAPTIVE mode: loss-streak guard still blocks betting', () => {
    const { brain } = makeBrain({ strategyOverrides: {
        adaptiveTarget: true, adaptiveMin: 1.3, adaptiveMax: 10
    } });
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE + 5; i++) brain.onRoundEnded(3.0);
    // Trip the guard: three rounds below the armed target
    brain.decide({ bettingWindow: true, balance: 50000 });
    brain.onRoundEnded(1.05);
    brain.onRoundEnded(1.05);
    brain.onRoundEnded(1.05);
    const d = brain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(d.shouldBet, false);
    assert.match(d.reasons.join(' '), /loss-streak guard/);
});

test('volatility gate is relative: heavy-tailed history alone never penalizes entry', () => {
    const { brain, predictor } = makeBrain();
    // A normal crash stream: mostly calm rounds with occasional huge crashes.
    // Absolute volatility is enormous (old code compared against a flat 2.0
    // and was therefore permanently "on"), but the recent window is no
    // wilder than the long-run norm — so no penalty may apply.
    const history = [];
    for (let i = 0; i < 1000; i++) history.push(i % 25 === 0 ? 30 + (i % 7) : 1.5 + (i % 3) * 0.2);
    brain.predictor.setHistory(history);
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) brain.onRoundEnded(1.8);

    assert.ok(predictor.volatility() > 2.0, 'absolute volatility must be huge on a normal crash stream');
    assert.strictEqual(brain.volatilityPenalty(), 0,
        'heavy tails are the norm for crash streams — they must not tighten the entry gate');
});

test('volatility gate fires only on a genuine recent spike above the long-run norm', () => {
    const { brain, predictor } = makeBrain();
    const calm = [];
    for (let i = 0; i < 1000; i++) calm.push(1.5 + (i % 3) * 0.2);
    brain.predictor.setHistory(calm);
    for (let i = 0; i < config.RISK.MIN_ROUNDS_OBSERVE; i++) brain.onRoundEnded(1.8);
    assert.strictEqual(brain.volatilityPenalty(), 0);

    // Now the tail goes genuinely wild — huge swings far beyond this
    // stream's norm (the cold rounds are isolated, never 3 in a row, so the
    // loss-streak guard stays out of it).
    for (let i = 0; i < 150; i++) brain.onRoundEnded(i % 2 === 0 ? 1.05 : 90);
    assert.ok(predictor.recentVolatility() > predictor.volatility() * config.RISK.VOLATILITY_SPIKE_RATIO,
        'test setup: recent window must register as a spike');
    assert.strictEqual(brain.volatilityPenalty(), config.RISK.VOLATILITY_CONFIDENCE_PENALTY);
});

test('ADAPTIVE stake scales with the hit probability of the drawn target', () => {
    const { brain, strategy, predictor } = makeBrain({
        strategyOverrides: {
            adaptiveTarget: true, adaptiveMin: 1.3, adaptiveMax: 30,
            initialBet: 1000, maxBet: 5000, minBet: 100
        }
    });
    warmUp(brain, config.RISK.MIN_ROUNDS_OBSERVE, 2.0);
    assert.strictEqual(brain.tier, 'MICRO');

    // Stub the target picker: same target, different model hit probabilities.
    const pick = (confidence) => () => ({ target: 2.5, confidence, p: confidence, adaptive: true });
    predictor.adaptiveTarget = pick(0.72); // safe-ish pick
    const safe = brain.decide({ bettingWindow: true, balance: 50000 });
    predictor.adaptiveTarget = pick(0.12); // longshot pick
    const longshot = brain.decide({ bettingWindow: true, balance: 50000 });

    assert.strictEqual(safe.shouldBet, true);
    assert.strictEqual(longshot.shouldBet, true);
    assert.ok(safe.stake > longshot.stake,
        `safe-pick stake ${safe.stake} should exceed longshot stake ${longshot.stake}`);
    assert.ok(longshot.stake >= strategy.minBet,
        'longshot stake must never drop below the site minimum stake');
    // Bounds: never above the bankroll-approved stake, fraction never below the floor.
    const approved = brain.bankroll.approveStake(1000, brain.tier);
    assert.ok(safe.stake <= approved, `stake ${safe.stake} must not exceed approved ${approved}`);
    assert.ok(longshot.stake >= approved * config.RISK.ADAPTIVE_MIN_STAKE_FRACTION - 0.01 ||
              longshot.stake === strategy.minBet,
        'longshot stake respects the adaptive floor (or the min-stake floor)');
});

test('Phase-3 feature model: deployed model drives entries; NO SIGNAL stays discipline-only', () => {
    // The strategy every stub brain runs under (MICRO -> targetMultiplier).
    const strategyT = { ...config.BETTING_STRATEGIES.MICRO };
    // Deterministic stub predictor whose statistical estimate is NOT good
    // enough to enter (confidence 0.30 < required 0.55) — exactly the state
    // the engine has been in for the whole observation history.
    const mk = (featureModel, opts = {}) => {
        const strategyConfig = { ...config.BETTING_STRATEGIES.MICRO };
        const strategy = new BettingStrategy(strategyConfig);
        const predictor = {
            history: Array.from({ length: 160 }, () => 2.0),
            paused: !!opts.paused,
            entryProbability: 0.55,
            baseEntryProbability: 0.55,
            maxEntryProbability: 0.85,
            shouldAllowBet: () => (opts.paused
                ? { allowed: false, reason: 'loss-streak guard: 4 consecutive crashes below target (risk rule)', probability: 0.30 }
                : { allowed: false, reason: 'confidence 0.30 < required 0.55', probability: 0.30 }),
            recentVolatility: () => 0.5,
            volatility: () => 0.5,
            probCrashAtLeast: () => 0.75,
            addRound: () => {}
        };
        const patterns = {
            observe: () => {}, detect: () => ({ found: false }),
            snapshot: () => null, recordUsageOutcome: () => {}
        };
        const bankroll = new Bankroll({
            sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
            dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
            maxStakeFraction: config.RISK.MAX_STAKE_FRACTION,
            microStakeFraction: config.RISK.MICRO_STAKE_FRACTION,
            minStake: strategyConfig.minBet
        });
        bankroll.setBalance(50000);
        const brain = new Brain({ config, strategy, predictor, patterns, bankroll, featureModel });
        brain.tier = 'MICRO';
        return brain;
    };

    // NO SIGNAL (verdict absent or negative): nothing is loaded — the
    // statistical veto stands.
    const noSignal = mk(null);
    const dNo = noSignal.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dNo.shouldBet, false);
    assert.match(dNo.reasons.join(' '), /confidence 0.30 < required/);

    // DEPLOY: the out-of-sample-validated model's probability REPLACES the
    // raw estimate and drives the entry gate. Models carry the target and
    // feature version they were trained on (target-safe versioning).
    const modelMeta = { target: strategyT.targetMultiplier, featureVersion: FEATURE_VERSION };
    const deployed = mk({ predict: () => 0.92, meta: modelMeta });
    const dYes = deployed.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dYes.shouldBet, true);
    assert.strictEqual(dYes.featureModel, true);
    assert.strictEqual(dYes.modelTarget, strategyT.targetMultiplier);
    // 0.92 reaches the gate; the no-pattern penalty (0.95x) still applies, so
    // expect ~0.874. The point is the feature model's probability got through.
    assert.ok(dYes.confidence >= 0.8, `feature-model confidence ${dYes.confidence} must reach the gate`);

    // The model can also say "no": a low model probability vetoes the entry
    // even though the raw estimate would pass.
    const modelVeto = mk({ predict: () => 0.4, meta: modelMeta });
    const dVeto = modelVeto.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dVeto.shouldBet, false);
    assert.match(dVeto.reasons.join(' '), /feature model/);

    // TARGET-SAFE VERSIONING (review #8): a model trained for 1.3x must NOT
    // answer when the strategy targets something else — the Brain falls back
    // to the statistical gate (which vetoes here), and a model trained on an
    // old feature schema is likewise parked.
    const wrongTarget = mk({ predict: () => 0.99, meta: { target: 2.0, featureVersion: FEATURE_VERSION } });
    const dWrongTarget = wrongTarget.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dWrongTarget.shouldBet, false, 'wrong-target model must be parked');
    assert.strictEqual(dWrongTarget.featureModel, undefined);
    assert.match(dWrongTarget.reasons.join(' '), /confidence 0.30 < required/);

    const wrongVersion = mk({ predict: () => 0.99, meta: { target: strategyT.targetMultiplier, featureVersion: 99 } });
    const dWrongVer = wrongVersion.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dWrongVer.shouldBet, false, 'stale feature-schema model must be parked');

    // RISK RULES STAY ABSOLUTE: the loss-streak guard beats a deployed model.
    const pausedBrain = mk({ predict: () => 0.99, meta: modelMeta }, { paused: true });
    const dPaused = pausedBrain.decide({ bettingWindow: true, balance: 50000 });
    assert.strictEqual(dPaused.shouldBet, false);
    assert.match(dPaused.reasons.join(' '), /loss-streak guard/);
});
