const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    fitLogistic, fitPlatt, logisticToJson, logisticFromJson,
    brierScore, brierSkill, bootstrapSkillCi, hitRatePValue, normCdf,
    lookElsewherePenalty, recentWindowNullPreds, modelStaleness,
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

test('fitPlatt corrects a systematically overconfident model', () => {
    // Raw probabilities are a distorted view of the truth: raw = 0.15 + 0.7*q
    // where q is the true probability. The true mapping raw -> outcome is NOT
    // identity. Platt must recover a map closer to the truth.
    const rng = makeRng(29);
    const probs = [], outcomes = [];
    for (let i = 0; i < 2000; i++) {
        const q = rng();                        // true probability
        const raw = 0.15 + 0.7 * q;             // miscalibrated reading
        outcomes.push(rng() < q ? 1 : 0);
        probs.push(raw);
    }
    const platt = fitPlatt(probs, outcomes);
    assert.ok(platt, 'Platt fit must succeed');
    // At raw = 0.5 the true probability is (0.5-0.15)/0.7 = 0.5; but the
    // miscalibration compresses the scale — check the fitted map moves the
    // extremes in the right direction vs identity.
    const calLow = platt.calibrate(0.2);   // true q ~ 0.07
    const calHigh = platt.calibrate(0.8);  // true q ~ 0.93
    assert.ok(calLow < 0.2, `low end must be pulled down (got ${calLow})`);
    assert.ok(calHigh > 0.8, `high end must be pulled up (got ${calHigh})`);
});

test('calibration survives the model JSON round-trip', () => {
    const rng = makeRng(41);
    const X = [], y = [];
    for (let i = 0; i < 200; i++) {
        const s = rng();
        X.push([s]);
        y.push(rng() < 0.2 + 0.7 * s ? 1 : 0);
    }
    const model = fitLogistic(X, y, [0]);
    const platt = fitPlatt(X.map((r) => model.predict(r)), y);
    assert.ok(platt);
    const json = logisticToJson(model, [0], ['signal'], { target: 1.3 }, platt);
    const restored = logisticFromJson(json);
    assert.ok(restored.calibrate, 'restored model must carry the calibrator');
    // predict() = calibrated(raw): differs from the raw output in general
    const raw = restored.rawPredict({ signal: 0.9 });
    const cal = restored.predict({ signal: 0.9 });
    assert.ok(Number.isFinite(cal) && cal > 0 && cal < 1);
    assert.ok(Math.abs(cal - platt.calibrate(raw)) < 1e-9, 'predict must apply Platt on top of raw');
    // A model saved WITHOUT a calibrator keeps identity behaviour.
    const plain = logisticFromJson(logisticToJson(model, [0], ['signal'], {}));
    assert.strictEqual(plain.calibrate, null);
    assert.ok(Math.abs(plain.predict({ signal: 0.9 }) - raw) < 1e-9);
});

test('recentWindowNullPreds is strictly online', () => {
    const prior = [1, 1, 1, 0, 0];
    const hold = [1, 0, 1, 1, 0];
    const preds = recentWindowNullPreds(prior, hold, 3);
    assert.strictEqual(preds.length, hold.length);
    // First prediction sees only the last 3 of `prior`: [1,0,0] -> 1/3
    assert.ok(Math.abs(preds[0] - 1 / 3) < 1e-9);
    // Second sees [0,0,1] (window advanced with hold[0]=1) -> 1/3
    assert.ok(Math.abs(preds[1] - 1 / 3) < 1e-9);
    // Third sees [0,1,0] -> 1/3 ... fourth [1,0,1] -> 2/3
    assert.ok(Math.abs(preds[3] - 2 / 3) < 1e-9);
});

test('modelStaleness flags verdicts outgrown by the data', () => {
    const verdict = { verdict: 'DEPLOY', rowsAtTraining: 1000 };
    const fresh = modelStaleness(verdict, 1200, 1000);
    assert.strictEqual(fresh.stale, false);
    assert.strictEqual(fresh.newRows, 200);
    const stale = modelStaleness(verdict, 2001, 1000);
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.newRows, 1001);
    // Missing metadata = cannot judge staleness -> treat as not stale
    assert.strictEqual(modelStaleness({}, 9999, 1000).stale, false);
});

test('bootstrapSkillCi with multiple nulls measures skill vs the BEST null', () => {
    const rng = makeRng(61);
    const n = 400;
    const outcomes = [], modelPreds = [], weakNull = [], strongNull = [];
    for (let i = 0; i < n; i++) {
        const s = rng();
        const won = rng() < 0.2 + 0.75 * s ? 1 : 0;
        outcomes.push(won);
        modelPreds.push(0.2 + 0.75 * s);
        weakNull.push(0.5);                       // crude average
        strongNull.push(0.2 + 0.75 * s + 0.001);  // near-perfect "simple" rival
    }
    const ciVsWeak = bootstrapSkillCi(modelPreds, [weakNull], outcomes, { iters: 200, rng: makeRng(42) });
    const ciVsBest = bootstrapSkillCi(modelPreds, [weakNull, strongNull], outcomes, { iters: 200, rng: makeRng(42) });
    assert.ok(ciVsWeak.lo > 0, 'model clearly beats the weak null');
    assert.ok(ciVsBest.point < ciVsWeak.point, 'vs best null the skill must shrink');
    assert.ok(ciVsBest.lo <= 0, 'a near-perfect rival must wipe out the skill claim');
});
