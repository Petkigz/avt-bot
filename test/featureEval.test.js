const test = require('node:test');
const assert = require('node:assert');
const { runFeatureEval, buildDataset, fitLogistic } = require('../scripts/feature-eval');
const { generateSynthetic } = require('../scripts/walk-forward');

test('buildDataset pairs strictly-prior features with the next round label', () => {
    const values = generateSynthetic(400, 0.03, 42);
    const { rows, names } = buildDataset(values, 1.3);
    assert.ok(names.length >= 15, `expected a rich feature vector, got ${names.length}`);
    assert.ok(rows.length >= 300);
    for (const r of rows.slice(0, 20)) {
        assert.strictEqual(r.x.length, names.length);
        assert.ok(r.y === 0 || r.y === 1);
    }
});

test('fitLogistic separates trivially learnable data', () => {
    // y fully determined by feature 0 — the fitter must achieve this OOS-style
    const X = [];
    const y = [];
    for (let i = 0; i < 400; i++) {
        const f0 = i % 2 === 0 ? 1 : -1;
        X.push([f0, Math.random()]);
        y.push(f0 > 0 ? 1 : 0);
    }
    const model = fitLogistic(X, y, [0, 1], { iters: 300 });
    let correct = 0;
    for (let i = 0; i < X.length; i++) if ((model.predict(X[i]) >= 0.5 ? 1 : 0) === y[i]) correct++;
    assert.ok(correct / X.length > 0.95, `logistic fit too weak: ${correct}/400`);
});

test('feature null-test finds no signal in genuinely random rounds', () => {
    const values = generateSynthetic(1500, 0.03, 99);
    const report = runFeatureEval(values, { target: 1.3, minTrain: 150, foldSize: 50 });
    assert.ok(!report.error);
    assert.match(report.correction, /holm-bonferroni over \d+ model comparisons/);
    assert.ok(Array.isArray(report.featureLifts) && report.featureLifts.length >= 15);
    // Ground truth: an independent RNG has no feature information. With
    // Holm-Bonferroni over all comparisons a false positive stays <5%.
    assert.strictEqual(report.signalDetected, false);
    assert.match(report.verdict, /NO FEATURE SIGNAL/);
});
