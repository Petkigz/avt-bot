const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Predictor = require('../game/predictor');

function makePredictor(overrides = {}) {
    return new Predictor({
        targetMultiplier: 1.5,
        minSampleSize: 10,
        minEntryProbability: 0.55,
        maxEntryProbability: 0.85,
        coldStreakLimit: 3,
        coldRecoveryCount: 1,
        ...overrides
    });
}

test('probCrashAtLeast uses Laplace smoothing', () => {
    const p = makePredictor();
    p.setHistory([2, 2, 2, 2]);
    assert.strictEqual(p.probCrashAtLeast(2), (4 + 1) / (4 + 2));
    assert.strictEqual(p.probCrashAtLeast(99), (0 + 1) / (4 + 2));
});

test('probCrashAtLeast returns null with no history', () => {
    const p = makePredictor();
    assert.strictEqual(p.probCrashAtLeast(1.5), null);
});

test('loss-streak guard pauses betting and warm rounds resume it', () => {
    const p = makePredictor({ minSampleSize: 2 });
    p.addRound(1.2);
    p.addRound(1.1);
    assert.strictEqual(p.paused, false);
    p.addRound(1.3); // third consecutive low crash -> pause
    assert.strictEqual(p.paused, true);
    assert.strictEqual(p.shouldAllowBet().allowed, false);

    p.addRound(2.5); // warm round -> resume
    assert.strictEqual(p.paused, false);
    assert.strictEqual(p.regime(), 'neutral'); // one warm round: warming up
    p.addRound(2.8); // second warm round -> hot
    assert.strictEqual(p.regime(), 'hot');
});

test('warming up allows bets with a flag', () => {
    const p = makePredictor({ minSampleSize: 100 });
    p.setHistory([2, 2, 2]);
    const decision = p.shouldAllowBet();
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.warmingUp, true);
});

test('low historical confidence blocks entry', () => {
    const p = makePredictor({ targetMultiplier: 2.0, minSampleSize: 10 });
    // Almost all rounds crash below 2.0
    const values = Array(40).fill(1.1);
    values.push(3.0, 3.0); // avoid the cold-streak pause
    p.setHistory(values);
    const decision = p.shouldAllowBet();
    assert.strictEqual(decision.allowed, false);
    assert.match(decision.reason, /confidence/);
});

test('learning stays within bounds', () => {
    const p = makePredictor();
    for (let i = 0; i < 100; i++) p.recordOutcome(false);
    assert.strictEqual(p.entryProbability, p.maxEntryProbability);
    for (let i = 0; i < 100; i++) p.recordOutcome(true);
    assert.strictEqual(p.entryProbability, p.baseEntryProbability);
});

test('setHistory recomputes the tail streak', () => {
    const p = makePredictor({ coldStreakLimit: 5 });
    p.setHistory([3, 3, 1.2, 1.2]);
    assert.strictEqual(p.consecutiveCold, 2);
    assert.strictEqual(p.paused, false);
    p.setHistory([3, 1.2, 1.2, 1.2]);
    assert.strictEqual(p.consecutiveCold, 3);
});

test('model state persists across restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predictor-'));
    const file = path.join(dir, 'model.json');

    const p1 = Predictor.load(file, { minEntryProbability: 0.55, maxEntryProbability: 0.85 });
    p1.recordOutcome(false);
    p1.recordOutcome(false);
    const savedThreshold = p1.entryProbability;

    const p2 = Predictor.load(file, { minEntryProbability: 0.55, maxEntryProbability: 0.85 });
    assert.strictEqual(p2.entryProbability, savedThreshold);
    assert.strictEqual(p2.settledBets.losses, 2);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('snapshot exposes model state for the dashboard', () => {
    const p = makePredictor();
    p.setHistory([1.2, 2.2, 3.3]);
    const snap = p.snapshot();
    assert.strictEqual(snap.roundsStudied, 3);
    assert.ok(['neutral', 'hot', 'cooling', 'cold'].includes(snap.regime));
    assert.ok(snap.probability > 0 && snap.probability <= 1);
});

test('recency weighting tracks the recent feed better than the flat average', () => {
    const p = makePredictor({ targetMultiplier: 2.0 });
    // 400 cold rounds, then 100 hot rounds
    for (let i = 0; i < 400; i++) p.addRound(1.1);
    for (let i = 0; i < 100; i++) p.addRound(3.0);
    const flat = p.probCrashAtLeast(2.0);
    const weighted = p.weightedProbCrashAtLeast(2.0);
    const recent = p.recentProbCrashAtLeast(2.0);
    assert.ok(recent > weighted, 'recent window sees the hot streak');
    assert.ok(weighted > flat, 'weighting moves toward the recent regime');
});

test('wilson lower bound is conservative on small samples', () => {
    const p = makePredictor({ targetMultiplier: 2.0 });
    for (let i = 0; i < 10; i++) p.addRound(3.0);
    const lb = p.wilsonLower(2.0);
    const point = p.recentProbCrashAtLeast(2.0);
    assert.ok(lb !== null && lb < point, 'lower bound below the point estimate');
});

test('uncertainty guard blocks when the recent floor is too low', () => {
    const p = makePredictor({ targetMultiplier: 2.0, minSampleSize: 10 });
    // Hot long-term history keeps the BLENDED point estimate above the entry
    // threshold, but the recent 100-round window is weak — the Wilson floor
    // must veto the entry anyway.
    const values = [];
    for (let i = 0; i < 400; i++) values.push(3.0);   // hot past
    for (let i = 0; i < 67; i++) values.push(1.1);    // weak recent window
    for (let i = 0; i < 33; i++) values.push(3.0);    // ends warm (no pause)
    p.setHistory(values);
    const decision = p.shouldAllowBet();
    assert.equal(decision.allowed, false);
});

test('entry thresholds scale with the target so high-target strategies stay operable', () => {
    // At the 1.3x design target the raw bounds are preserved EXACTLY.
    const p13 = makePredictor({ targetMultiplier: 1.3 });
    assert.strictEqual(p13.baseEntryProbability, 0.55);
    assert.strictEqual(p13.maxEntryProbability, 0.85);
    // Below the design target nothing changes either.
    const p12 = makePredictor({ targetMultiplier: 1.2 });
    assert.strictEqual(p12.baseEntryProbability, 0.55);
    // A 2x target scales both bounds by 1.3/2 — an absolute 0.55 gate would
    // be unreachable (P(crash >= 2x) ~ 45%) and silently disable the preset.
    const p20 = makePredictor({ targetMultiplier: 2.0 });
    assert.ok(Math.abs(p20.baseEntryProbability - 0.55 * 0.65) < 1e-9);
    assert.ok(Math.abs(p20.maxEntryProbability - 0.85 * 0.65) < 1e-9);
});

test('retarget() rescales thresholds and re-evaluates the regime streak', () => {
    const p = makePredictor({ targetMultiplier: 1.3, minSampleSize: 10 });
    // Tail: 3 rounds between 1.3x and 2x — warm at 1.3x, cold at 2x.
    p.setHistory([2.0, 2.0, 1.5, 1.5, 1.5]);
    assert.strictEqual(p.paused, false);

    p.retarget(2.0);
    assert.strictEqual(p.targetMultiplier, 2.0);
    assert.ok(Math.abs(p.baseEntryProbability - 0.55 * 0.65) < 1e-9);
    assert.strictEqual(p.entryProbability, p.baseEntryProbability);
    assert.strictEqual(p.consecutiveCold, 3);
    assert.strictEqual(p.paused, true, 'three sub-2x crashes must trip the loss-streak guard');
    // History is target-independent and must survive the retarget.
    assert.strictEqual(p.history.length, 5);
});

test('blended probability falls back to plain estimate on short history', () => {
    const p = makePredictor();
    p.setHistory([1.2, 2.2, 3.3]);
    assert.equal(p.blendedProbability(2.0), p.probCrashAtLeast(2.0));
});

test('adaptiveTarget stays inside bounds and varies with the drawn probability', () => {
    const p = makePredictor({ targetMultiplier: 1.5, minSampleSize: 20 });
    // Mixed stream with a real tail
    const stream = [];
    for (let i = 0; i < 300; i++) stream.push(1 + Math.pow((i * 7919) % 100 / 100, 3) * 12);
    p.setHistory(stream);

    const timid = p.adaptiveTarget({ minTarget: 1.3, maxTarget: 30, rng: () => 0 });   // p = minProb
    const greedy = p.adaptiveTarget({ minTarget: 1.3, maxTarget: 30, rng: () => 0.999 }); // p ~ maxProb
    for (const pick of [timid, greedy]) {
        assert.ok(pick.adaptive);
        assert.ok(pick.target >= 1.3 && pick.target <= 30, `target ${pick.target} out of bounds`);
        assert.ok(pick.confidence > 0 && pick.confidence <= 1);
    }
    // High hit-probability draw -> small target; low draw -> bigger target
    assert.ok(greedy.target <= timid.target,
        `greedy ${greedy.target}x should not exceed timid ${timid.target}x`);
});

test('adaptiveTarget follows the model: hot tail picks bigger targets than cold tail', () => {
    const mk = (values) => {
        const p = makePredictor({ targetMultiplier: 1.5, minSampleSize: 20 });
        p.setHistory(values);
        return p;
    };
    const hot = [];
    const cold = [];
    for (let i = 0; i < 200; i++) {
        hot.push(i % 4 === 0 ? 8 + (i % 7) : 1.1 + (i % 3) * 0.2);
        cold.push(1.05 + (i % 5) * 0.05);
    }
    const mid = () => 0.5; // same drawn ambition for both
    const hotPick = mk(hot).adaptiveTarget({ minTarget: 1.3, maxTarget: 30, rng: mid });
    const coldPick = mk(cold).adaptiveTarget({ minTarget: 1.3, maxTarget: 30, rng: mid });
    assert.ok(hotPick.target > coldPick.target,
        `hot-tail target ${hotPick.target} should exceed cold-tail ${coldPick.target}`);
});

test('adaptiveTarget falls back to the nominal target before enough history', () => {
    const p = makePredictor({ targetMultiplier: 1.5, minSampleSize: 50 });
    p.setHistory([1.2, 2.0, 1.4]);
    const pick = p.adaptiveTarget({ minTarget: 1.3, maxTarget: 30 });
    assert.strictEqual(pick.adaptive, false);
    assert.strictEqual(pick.target, 1.5);
});
