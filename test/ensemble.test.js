'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { logit, sigmoid, blendEnsemble, brierScore, logLoss, fitEnsembleWeights } = require('../game/ensemble');

test('ensemble: logit and sigmoid are exact mathematical inverses', () => {
    const probs = [0.10, 0.25, 0.50, 0.75, 0.90];
    for (const p of probs) {
        const l = logit(p);
        const inv = sigmoid(l);
        assert.ok(Math.abs(p - inv) < 1e-4, `sigmoid(logit(${p})) should equal ${p}, got ${inv}`);
    }
});

test('ensemble: handles empty and single-source inputs safely', () => {
    const emptyRes = blendEnsemble([]);
    assert.strictEqual(emptyRes.probability, null);
    assert.strictEqual(emptyRes.sourcesUsed.length, 0);

    const singleRes = blendEnsemble([{ name: 'stat', prob: 0.72, weight: 1.0 }]);
    assert.strictEqual(singleRes.probability, 0.72);
    assert.strictEqual(singleRes.sourcesUsed[0], 'stat');
});

test('ensemble: combines statistical, feature model, and hypothesis sources with weighting', () => {
    const sources = [
        { name: 'statistical', prob: 0.70, weight: 1.0 },
        { name: 'feature_model', prob: 0.80, weight: 1.5 },
        { name: 'hyp_pattern_LLH', prob: 0.85, weight: 1.8 }
    ];

    const res = blendEnsemble(sources);
    assert.ok(res.probability > 0.70 && res.probability < 0.85, 'blended ensemble probability should lie within bounds');
    assert.strictEqual(res.sourcesUsed.length, 3);
    assert.ok(res.weights.feature_model > res.weights.statistical);
});

test('ensemble: computes brierScore and logLoss accurately', () => {
    const preds = [0.9, 0.1, 0.8];
    const actuals = [1, 0, 1];
    const brier = brierScore(preds, actuals);
    // ( (0.9-1)^2 + (0.1-0)^2 + (0.8-1)^2 ) / 3 = (0.01 + 0.01 + 0.04) / 3 = 0.06 / 3 = 0.02
    assert.ok(Math.abs(brier - 0.02) < 1e-4);

    const loss = logLoss(preds, actuals);
    assert.ok(loss > 0 && loss < 0.5);
});

test('ensemble: fitEnsembleWeights finds optimal weights minimizing validation Brier loss', () => {
    // Generate synthetic OOS predictions where model A has 80% accuracy and model B has 55% accuracy
    const dataset = [];
    for (let i = 0; i < 100; i++) {
        const y = i % 2 === 0 ? 1 : 0;
        const probA = y === 1 ? 0.85 : 0.15; // Strong model
        const probB = y === 1 ? 0.55 : 0.45; // Weak noisy model
        dataset.push({
            probs: { strongModel: probA, weakModel: probB },
            outcome: y
        });
    }

    const res = fitEnsembleWeights(dataset, ['strongModel', 'weakModel']);
    assert.ok(res.weights.strongModel > res.weights.weakModel, 'Optimizer should assign higher weight to strongModel');
    assert.ok(res.brier <= res.baselineBrier, 'Optimized ensemble Brier should be <= baseline average Brier');
});
