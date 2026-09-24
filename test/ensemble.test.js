'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { logit, sigmoid, blendEnsemble } = require('../game/ensemble');

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
