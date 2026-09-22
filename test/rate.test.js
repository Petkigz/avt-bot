const test = require('node:test');
const assert = require('node:assert/strict');
const { recordSample, roundsPerHour, isStalled } = require('../util/rate');

test('recordSample appends and prunes old samples', () => {
    const win = [];
    const now = 1_000_000_000_000;
    recordSample(win, 1, now - 20 * 60 * 1000); // too old after pruning below
    recordSample(win, 5, now);
    assert.equal(win.length, 1); // old sample pruned (default window 10 min)
    assert.equal(win[0].roundId, 5);
});

test('roundsPerHour computes the rate over the window', () => {
    const win = [];
    const now = Date.now();
    recordSample(win, 0, now - 5 * 60 * 1000);
    recordSample(win, 25, now); // 25 rounds in 5 minutes = 300/hr
    const rate = roundsPerHour(win);
    assert.ok(Math.abs(rate - 300) < 0.001, `rate was ${rate}`);
});

test('roundsPerHour is 0 when it cannot be computed', () => {
    assert.equal(roundsPerHour([]), 0);
    assert.equal(roundsPerHour([{ t: 1, roundId: 1 }]), 0);
    const win = [{ t: 100, roundId: 5 }, { t: 100, roundId: 5 }];
    assert.equal(roundsPerHour(win), 0); // zero elapsed time
    const reset = [{ t: 100, roundId: 9 }, { t: 200, roundId: 1 }]; // roundId reset
    assert.equal(roundsPerHour(reset), 0);
});

test('isStalled only after a flat window long enough', () => {
    const now = Date.now();
    const flat = [
        { t: now - 6 * 60 * 1000, roundId: 42 },
        { t: now, roundId: 42 }
    ];
    assert.equal(isStalled(flat), true);
    const shortFlat = [
        { t: now - 60 * 1000, roundId: 42 },
        { t: now, roundId: 42 }
    ];
    assert.equal(isStalled(shortFlat), false); // only 1 minute flat
    const moving = [
        { t: now - 6 * 60 * 1000, roundId: 1 },
        { t: now, roundId: 99 }
    ];
    assert.equal(isStalled(moving), false);
    assert.equal(isStalled([]), false);
});
