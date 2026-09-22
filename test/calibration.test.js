'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CalibrationTracker = require('../game/calibration');

test('empty tracker reports nulls', () => {
    const c = new CalibrationTracker();
    const s = c.stats();
    assert.equal(s.count, 0);
    assert.equal(s.brier, null);
    assert.equal(s.ece, null);
    assert.equal(c.summary(), 'no settled predictions yet');
});

test('perfectly calibrated constant predictor has near-zero ECE', () => {
    const c = new CalibrationTracker();
    // 700 predictions at 0.7, 70% of them win
    for (let i = 0; i < 700; i++) c.record(0.7, i % 10 < 7 ? 1 : 0);
    const s = c.stats();
    assert.equal(s.count, 700);
    assert.ok(s.ece < 0.02, `ECE should be tiny, got ${s.ece}`);
    assert.ok(s.brier > 0.2 && s.brier < 0.22); // p(1-p) = 0.21
});

test('overconfident predictor shows large ECE', () => {
    const c = new CalibrationTracker();
    for (let i = 0; i < 100; i++) c.record(0.95, 0); // says 95%, never wins
    const s = c.stats();
    assert.ok(s.ece > 0.9, `ECE should be huge, got ${s.ece}`);
    assert.ok(Number.isFinite(s.logLoss) && s.logLoss > 2);
});

test('rejects invalid probabilities and clamps extremes', () => {
    const c = new CalibrationTracker();
    assert.equal(c.record(1.5, 1), false);
    assert.equal(c.record(-0.1, 0), false);
    assert.equal(c.record(NaN, 1), false);
    assert.equal(c.record(1, 1), true); // clamped, log loss stays finite
    assert.equal(c.record(0, 0), true);
    const s = c.stats();
    assert.ok(Number.isFinite(s.logLoss));
    assert.equal(s.bins.length, 10);
});
