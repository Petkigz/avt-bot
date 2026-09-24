const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    fitLogistic, logisticToJson, logisticFromJson,
    brierScore, brierSkill, bootstrapSkillCi, hitRatePValue, normCdf,
    lookElsewherePenalty,
    writeModelVerdict, readModelVerdict, saveFeatureModel, loadFeatureModel
} = require('../game/modelLayer');

// Deterministic RNG for synthetic data.
function makeRng(seed = 7) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

test('fitLogistic learns a separable signal; JSON round-trip preserves predictions', () => {
    const rng = makeRng();
    const n = 400;
    // feature 0 carries the signal, feature 1 is pure noise
    const X = [], y = [];
    for (let i = 0; i < n; i++) {
        const s = rng();
        X.push([s, rng()]);
        y.push(rng() < 0.2 + 0.7 * s ? 1 : 0);
    }
    const model = fitLogistic(X, y, [0, 1]);
    assert.ok(model, 'fit must succeed');

    const low = model.predict([0.05, 0.5]);
    const high = model.predict([0.95, 0.5]);
    assert.ok(high > low + 0.2, `model must separate (low ${low}, high ${high})`);

    // Round-trip through the serialization used for live deployment.
    const restored = logisticFromJson(logisticToJson(model, [0, 1], ['signal', 'noise'], { target: 1.3 }));
    assert.ok(restored, 'restore must succeed');
    // predict() on restored models takes a FEATURE OBJECT (Brain's shape).
    assert.ok(Math.abs(restored.predict({ signal: 0.95, noise: 0.5 }) - high) < 1e-9);
    assert.ok(Math.abs(restored.predict({ signal: 0.05, noise: 0.5 }) - low) < 1e-9);
    // Missing feature imputes to the train mean — must not throw or NaN.
    const p = restored.predict({ noise: 0.5 });
    assert.ok(Number.isFinite(p) && p > 0 && p < 1);
});

test('Brier skill: positive when model beats the null, negative when worse', () => {
    const outcomes = [1, 1, 1, 0, 0, 1, 0, 1, 1, 0];
    const good = outcomes.map((o) => (o ? 0.9 : 0.2));   // well calibrated
    const nullPreds = outcomes.map(() => 0.6);
    const skill = brierSkill(brierScore(good, outcomes), brierScore(nullPreds, outcomes));
    assert.ok(skill > 0, `good model must show positive skill (got ${skill})`);

    const anti = outcomes.map((o) => (o ? 0.1 : 0.9));   // systematically wrong
    const antiSkill = brierSkill(brierScore(anti, outcomes), brierScore(nullPreds, outcomes));
    assert.ok(antiSkill < 0, `wrong model must show negative skill (got ${antiSkill})`);
});

test('bootstrapSkillCi is seeded-deterministic and brackets the point estimate', () => {
    const rngData = makeRng(3);
    const n = 500;
    const outcomes = [], modelPreds = [], nullPreds = [];
    for (let i = 0; i < n; i++) {
        const s = rngData();
        const won = rngData() < 0.2 + 0.75 * s ? 1 : 0;
        outcomes.push(won);
        modelPreds.push(0.2 + 0.75 * s);   // knows the signal
        nullPreds.push(0.575);
    }
    const rng1 = makeRng(42), rng2 = makeRng(42);
    const ci1 = bootstrapSkillCi(modelPreds, nullPreds, outcomes, { iters: 300, rng: rng1 });
    const ci2 = bootstrapSkillCi(modelPreds, nullPreds, outcomes, { iters: 300, rng: rng2 });
    assert.deepStrictEqual(ci1, ci2, 'same seed must reproduce the same CI');
    assert.ok(ci1.lo <= ci1.point && ci1.point <= ci1.hi);
    assert.ok(ci1.lo > 0, `strong planted signal must yield lo > 0 (got ${ci1.lo})`);
});

test('hitRatePValue: chance-level hits are not significant, excess hits are', () => {
    // 100 entries at 77% hit rate against a 76.9% break-even = pure noise
    const pNoise = hitRatePValue(77, 100, 0.769);
    assert.ok(pNoise > 0.05, `noise-level hit rate must not be significant (p=${pNoise})`);
    // 100 entries at 90% hit rate against the same break-even = clear excess
    const pSignal = hitRatePValue(90, 100, 0.769);
    assert.ok(pSignal < 0.01, `strong excess must be significant (p=${pSignal})`);
});

test('normCdf sanity', () => {
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
});

test('lookElsewherePenalty grows with searched space, shrinks with evidence', () => {
    assert.ok(lookElsewherePenalty(20, 100) > lookElsewherePenalty(20, 3),
        'bigger mined space must demand more evidence');
    assert.ok(lookElsewherePenalty(500, 27) < lookElsewherePenalty(20, 27),
        'more live uses must shrink the penalty');
    assert.strictEqual(lookElsewherePenalty(0, 27), Infinity, 'no evidence = infinite demand');
});

test('verdict + model persistence round-trips per site', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelLayer-'));
    const verdict = { verdict: 'NO_SIGNAL', reason: 'test', brierSkill: -0.01 };
    writeModelVerdict(dir, 'site-a', verdict);
    const read = readModelVerdict(dir, 'site-a');
    assert.strictEqual(read.verdict, 'NO_SIGNAL');
    assert.ok(read.ts > 0);
    assert.strictEqual(readModelVerdict(dir, 'missing-site'), null);

    const rng = makeRng(11);
    const X = [], y = [];
    for (let i = 0; i < 60; i++) {
        const s = rng();
        X.push([s]);
        y.push(rng() < 0.3 + 0.6 * s ? 1 : 0);
    }
    const model = fitLogistic(X, y, [0]);
    saveFeatureModel(dir, 'site-a', logisticToJson(model, [0], ['signal'], { target: 1.3 }));
    const live = loadFeatureModel(dir, 'site-a');
    assert.ok(live, 'live model must load');
    assert.ok(live.predict({ signal: 1 }) > live.predict({ signal: 0 }));
    assert.strictEqual(loadFeatureModel(dir, 'missing-site'), null);
    fs.rmSync(dir, { recursive: true, force: true });
});
