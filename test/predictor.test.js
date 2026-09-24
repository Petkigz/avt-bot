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

test('model state persists across restarts and rescales correctly across target changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predictor-'));
    const file = path.join(dir, 'model.json');

    // 1. Saved at 1.3x baseline
    const p1 = Predictor.load(file, { targetMultiplier: 1.3, minEntryProbability: 0.55, maxEntryProbability: 0.85 });
    p1.recordOutcome(false); // tightened 0.55 -> 0.57
    p1.recordOutcome(false); // tightened 0.57 -> 0.59
    assert.ok(Math.abs(p1.entryProbability - 0.59) < 1e-9);
    p1.save();

    // 2. Loaded at same target: preserves exact tightened threshold
    const p2 = Predictor.load(file, { targetMultiplier: 1.3, minEntryProbability: 0.55, maxEntryProbability: 0.85 });
    assert.ok(Math.abs(p2.entryProbability - 0.59) < 1e-9);
    assert.strictEqual(p2.settledBets.losses, 2);

    // 3. Loaded at a different target (2.0x): must NOT import 0.59 (which is above 2x ceiling 0.5525)
    // It should rescale the tightness fraction ((0.59-0.55)/0.30 = 0.133) into the 2x window.
    const p3 = Predictor.load(file, { targetMultiplier: 2.0, minEntryProbability: 0.55, maxEntryProbability: 0.85 });
    assert.ok(p3.entryProbability < 0.40, `expected rescaled entryProbability near ~0.38, got ${p3.entryProbability}`);
    assert.ok(p3.entryProbability >= p3.baseEntryProbability);

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
    // The guard is RECALIBRATED for the new target: at 2x losses are the norm
    // (~50%), so 3 cold rounds are noise, not a pause-worthy streak — the
    // effective limit widens (3 -> 5) instead of pinning the engine silent.
    assert.ok(p.effectiveColdLimit > p.coldStreakLimit, 'high targets widen the guard');
    assert.strictEqual(p.paused, false, 'widened 2x guard must not trip on 3 cold rounds');
    // Five consecutive sub-2x rounds DO trip the recalibrated guard.
    p.addRound(1.4);
    p.addRound(1.2);
    assert.strictEqual(p.consecutiveCold, 5);
    assert.strictEqual(p.paused, true, 'five sub-2x crashes must trip the widened guard');
    // Retargeting back to a low target restores the configured limit and
    // re-judges the streak against the new target (1.4/1.5 are warm at 1.3x).
    p.retarget(1.3);
    assert.strictEqual(p.effectiveColdLimit, p.coldStreakLimit);
    assert.strictEqual(p.paused, false);
    // History is target-independent and must survive the retarget.
    assert.strictEqual(p.history.length, 7);
});

test('loss-streak guard limit scales with high targets (no permanent silence)', () => {
    // Low targets: the configured limit applies UNCHANGED (calibration zone).
    const p13 = makePredictor({ targetMultiplier: 1.3 });
    assert.strictEqual(p13.effectiveColdLimit, p13.coldStreakLimit);
    const p15 = makePredictor({ targetMultiplier: 1.5 });
    assert.strictEqual(p15.effectiveColdLimit, p15.coldStreakLimit);
    // 2x: losses happen ~half the time, so 3-in-a-row is ordinary noise —
    // the limit widens to keep the guard's trigger frequency meaningful.
    const p20 = makePredictor({ targetMultiplier: 2.0 });
    assert.strictEqual(p20.effectiveColdLimit, 5);
    // Extreme targets are capped at 3x the configured limit.
    const p10 = makePredictor({ targetMultiplier: 10 });
    assert.strictEqual(p10.effectiveColdLimit, p10.coldStreakLimit * 3);
    // And the widened guard still pauses on a REAL cold streak.
    p20.setHistory([1.1, 1.2, 1.3, 1.4, 1.5]);
    assert.strictEqual(p20.paused, true, 'five sub-2x crashes must still trip the guard');
    // One warm round resumes it (recovery count unchanged).
    p20.addRound(2.5);
    assert.strictEqual(p20.paused, false);
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

test('recentVolatility reflects the recent window, not the whole history', () => {
    const p = makePredictor();
    // 200 calm rounds, then 20 wild rounds — full-history vol stays dominated
    // by the wild tail only in the RECENT read.
    const history = [];
    for (let i = 0; i < 200; i++) history.push(1.5 + (i % 2) * 0.1);
    for (let i = 0; i < 20; i++) history.push(40);
    p.setHistory(history);
    const recent = p.recentVolatility(50); // last 50: 30 calm + 20 wild
    const long = p.volatility();
    assert.ok(Number.isFinite(recent) && Number.isFinite(long));
    assert.ok(recent > long, `recent ${recent} should exceed long-run ${long} on a wild tail`);
    // A purely calm stream has near-zero recent volatility.
    const calm = makePredictor();
    calm.setHistory(new Array(120).fill(1.6));
    assert.ok(calm.recentVolatility() < 1e-9);
});

test('silence breaker: a loss-ratcheted entry gate decays back to baseline when no bets settle', () => {
    const p = makePredictor({ minEntryProbability: 0.60, silenceLimit: 10 });
    // Past losses tighten the gate to the ceiling...
    for (let i = 0; i < 20; i++) p.recordOutcome(false);
    assert.strictEqual(p.entryProbability, p.maxEntryProbability);
    // ...and under the old code it stayed there forever (no bets -> no wins ->
    // no loosening). Now: after silenceLimit rounds with no settled bet the
    // gate decays one loosen-step per round back to baseline.
    const loosen = p.loosenStep;
    const stepsNeeded = Math.ceil((p.entryProbability - p.baseEntryProbability) / loosen);
    for (let i = 0; i < p.silenceLimit + stepsNeeded + 2; i++) p.addRound(1.6);
    assert.strictEqual(p.entryProbability, p.baseEntryProbability,
        'entry gate must relax fully back to baseline after prolonged silence');
    // A settled bet resets the silence countdown.
    for (let i = 0; i < 20; i++) p.recordOutcome(false);
    p.recordOutcome(true);
    assert.strictEqual(p.silentRounds, 0);
});

test('silence breaker does not decay while bets keep settling', () => {
    const p = makePredictor({ minEntryProbability: 0.60, silenceLimit: 5 });
    for (let i = 0; i < 10; i++) p.recordOutcome(false);
    const tightened = p.entryProbability;
    assert.ok(tightened > p.baseEntryProbability);
    // Rounds keep passing, but a bet settles every round -> never silent.
    for (let i = 0; i < 30; i++) {
        p.addRound(1.6);
        p.recordOutcome(true);
        p.recordOutcome(false);
    }
    assert.ok(p.entryProbability > p.baseEntryProbability,
        'an actively-betting engine keeps its tightened gate');
});
