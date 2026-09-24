'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    generateAllHypotheses,
    evaluatePartition,
    runHypothesisEngine
} = require('../research/hypothesisEngine');
const {
    createWorld1_PureIid,
    createWorld2_MarkovDependency,
    createWorld3_RegimeSwitching,
    createWorld4_TrajectoryTraces,
    createWorld5_PatternSignal,
    createWorld6_DecayingSignal
} = require('../sim/syntheticWorlds');

test('syntheticWorlds: all 6 worlds produce valid finite crash series', () => {
    const w1 = createWorld1_PureIid(100);
    assert.strictEqual(w1.length, 100);
    w1.forEach((v) => assert.ok(Number.isFinite(v) && v >= 1.00));

    const w2 = createWorld2_MarkovDependency(100);
    assert.strictEqual(w2.length, 100);

    const w3 = createWorld3_RegimeSwitching(100);
    assert.strictEqual(w3.length, 100);

    const w4 = createWorld4_TrajectoryTraces(50);
    assert.strictEqual(w4.length, 50);
    assert.ok(w4[0].samples.length >= 2);

    const w5 = createWorld5_PatternSignal(100);
    assert.strictEqual(w5.length, 100);

    const w6 = createWorld6_DecayingSignal(100);
    assert.strictEqual(w6.length, 100);
});

test('hypothesisEngine: generateAllHypotheses creates valid search space', () => {
    const hyps = generateAllHypotheses();
    assert.ok(hyps.length > 50, 'hypothesis catalog should have extensive search space');
    hyps.forEach((h) => {
        assert.ok(h.id && h.name && h.target > 1.0 && typeof h.predicate === 'function');
    });
});

test('hypothesisEngine: pure IID noise (World 1) yields 0 confirmed hypotheses', () => {
    const iid = createWorld1_PureIid(1200, 999);
    const res = runHypothesisEngine(iid);
    assert.strictEqual(res.verdict, 'NO_HYPOTHESIS_SURVIVED_HOLDOUT');
    assert.strictEqual(res.tier3HoldoutConfirmed, 0);
    assert.strictEqual(res.finalRegistry.length, 0);
});

test('hypothesisEngine: planted pattern signal (World 5) is discovered and confirmed on holdout', () => {
    const stream = createWorld5_PatternSignal(2000, 505);
    const res = runHypothesisEngine(stream);
    assert.ok(res.tier1Discovered >= 1, 'should pass tier 1 discovery');
    assert.ok(res.tier2OosConfirmed >= 1, 'should pass tier 2 out-of-sample');
    assert.strictEqual(res.verdict, 'HYPOTHESIS_CONFIRMED_ON_HOLDOUT');
    assert.ok(res.tier3HoldoutConfirmed >= 1, 'should pass tier 3 holdout confirmation');

    const confirmed = res.finalRegistry.find((c) => c.status === 'HOLDOUT_CONFIRMED');
    assert.ok(confirmed, 'at least one candidate confirmed on locked holdout');
    assert.ok(confirmed.name.includes('LLH') || confirmed.name.includes('1.5'));
});

test('hypothesisEngine: transient / decaying signal (World 6) is rejected by OOS / Holdout', () => {
    const stream = createWorld6_DecayingSignal(1500, 606);
    const res = runHypothesisEngine(stream);
    // Even if it slipped past discovery or OOS, it MUST NOT confirm on holdout
    assert.strictEqual(res.tier3HoldoutConfirmed, 0, 'decayed signal must not confirm on final holdout');
    assert.strictEqual(res.verdict, 'NO_HYPOTHESIS_SURVIVED_HOLDOUT');
});
