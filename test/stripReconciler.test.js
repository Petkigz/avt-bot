'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { reconcileStrip } = require('../game/stripReconciler');

test('identical strip produces zero new rounds', () => {
    const strip = [3.09, 1.20, 5.50, 1.10];
    const res = reconcileStrip(strip, strip);
    assert.strictEqual(res.newRounds.length, 0);
    assert.strictEqual(res.recoveredCount, 0);
    assert.strictEqual(res.overlapped, true);
});

test('single new round is detected correctly', () => {
    const prev = [1.20, 5.50, 1.10];
    const curr = [3.09, 1.20, 5.50, 1.10];
    const res = reconcileStrip(prev, curr);
    assert.deepStrictEqual(res.newRounds, [3.09]);
    assert.strictEqual(res.recoveredCount, 0);
    assert.strictEqual(res.overlapped, true);
});

test('multiple intermediate rounds are recovered in chronological order', () => {
    // 3 rounds happened between polls: 1.18, then 3.72, then 1.04
    const prev = [1.40, 1.12, 2.31, 10.0];
    const curr = [1.04, 3.72, 1.18, 1.40, 1.12, 2.31];
    const res = reconcileStrip(prev, curr);
    assert.deepStrictEqual(res.newRounds, [1.18, 3.72, 1.04], 'rounds must be chronological (oldest -> newest)');
    assert.strictEqual(res.recoveredCount, 2, '2 intermediate rounds were recovered');
    assert.strictEqual(res.overlapped, true);
});

test('reconciler handles duplicate values without misalignment', () => {
    const prev = [1.00, 1.00, 2.50, 1.30];
    const curr = [1.50, 1.00, 1.00, 2.50, 1.30];
    const res = reconcileStrip(prev, curr);
    assert.deepStrictEqual(res.newRounds, [1.50]);
    assert.strictEqual(res.overlapped, true);
});

test('complete strip rollover flags non-overlap and returns newest round', () => {
    const prev = [1.20, 1.30, 1.40];
    const curr = [55.0, 32.0, 18.0];
    const res = reconcileStrip(prev, curr);
    assert.deepStrictEqual(res.newRounds, [55.0]);
    assert.strictEqual(res.overlapped, false, 'unmatched strip flags non-overlap');
});

test('empty or invalid inputs fail gracefully', () => {
    assert.deepStrictEqual(reconcileStrip([], [1.2]).newRounds, [1.2]);
    assert.deepStrictEqual(reconcileStrip([1.2], []).newRounds, []);
    assert.deepStrictEqual(reconcileStrip(null, null).newRounds, []);
});
