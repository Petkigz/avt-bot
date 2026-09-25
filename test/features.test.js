'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFeatures, symbolOf, FEATURE_VERSION } = require('../game/features');

test('empty history yields empty feature set', () => {
    assert.deepEqual(extractFeatures([], 1.3), {});
    assert.deepEqual(extractFeatures(null, 1.3), {});
});

test('feature values on a known sequence', () => {
    // 8 rounds: four lows (1.1), then 2.0, 3.0, 1.2, 1.05  (target 1.3)
    const values = [1.1, 1.1, 1.1, 1.1, 2.0, 3.0, 1.2, 1.05];
    const f = extractFeatures(values, 1.3);

    assert.equal(f.last_1, 1.05);
    assert.equal(f.last_5, 1.1);
    assert.equal(f.last_5 !== null, true);

    // lows below 1.3: 1.1 x4, 1.2, 1.05 => 6/8 over the full (<=10) window
    assert.equal(f.low_rate_10, 0.75);
    // highs >= 2.0: 2.0 and 3.0 => 2/8
    assert.equal(f.high_rate_10, 0.25);

    // trailing low streak: 1.2, 1.05 -> 2
    assert.equal(f.consecutive_low, 2);
    // last round >= 2.0 was the 3.0 at index 5 -> 2 rounds ago
    assert.equal(f.rounds_since_high, 2);

    assert.equal(f.rolling_mean_5, Number(((1.1 + 2.0 + 3.0 + 1.2 + 1.05) / 5).toFixed(3)));
    assert.ok(Number.isFinite(f.std_10));
    assert.ok(Number.isFinite(f.entropy_30) && f.entropy_30 > 0);
    assert.equal(f.recent_vs_long_low, 0); // single window, identical rates
});

test('short histories degrade gracefully', () => {
    const f = extractFeatures([2.5], 1.3);
    assert.equal(f.last_1, 2.5);
    assert.equal(f.last_2, null);
    assert.equal(f.consecutive_low, 0);
    assert.equal(f.rounds_since_high, 0);
    assert.equal(f.std_10, null); // needs >= 2 values
});

test('symbols match the pattern detector bins', () => {
    assert.equal(symbolOf(1.49), 'L');
    assert.equal(symbolOf(1.5), 'M');
    assert.equal(symbolOf(2.49), 'M');
    assert.equal(symbolOf(2.5), 'H');
});

test('cold streak shifts recent_vs_long_low positive', () => {
    const values = [];
    for (let i = 0; i < 90; i++) values.push(2.0);   // warm century
    for (let i = 0; i < 10; i++) values.push(1.1);   // recent cold
    const f = extractFeatures(values, 1.3);
    assert.ok(f.recent_vs_long_low > 0.7);
    assert.equal(f.consecutive_low, 10);
});

test('features: extracts microstructure and inter-round timing when provided', () => {
    const values = [1.50, 2.00, 1.35, 1.80];
    const mockTraces = [
        [
            { t: 0, v: 1.00 },
            { t: 300, v: 1.15 },
            { t: 600, v: 1.35 }
        ]
    ];
    const extraContext = {
        traces: mockTraces,
        interRoundDelaySec: 4.5,
        timeTo12: 450,
        timeTo15: 850
    };

    const f = extractFeatures(values, 1.3, extraContext);
    assert.ok(Number.isFinite(f.early_slope_avg_3), 'early_slope_avg_3 should be computed');
    assert.ok(Number.isFinite(f.early_accel_avg_3), 'early_accel_avg_3 should be computed');
    assert.equal(f.inter_round_delay, 4.5);
    assert.equal(f.time_to_12_last, 450);
    assert.equal(f.time_to_15_last, 850);
});

test('features: extracts autocorrelation, transitions, quantiles, and entropy in V3', () => {
    const values = [];
    for (let i = 0; i < 60; i++) {
        values.push(i % 2 === 0 ? 1.15 : 2.50);
    }
    const f = extractFeatures(values, 1.3);

    assert.equal(FEATURE_VERSION, 3);
    assert.ok(Number.isFinite(f.autocorr_lag1), 'autocorr_lag1 finite');
    assert.ok(Number.isFinite(f.quantile_25), 'quantile_25 finite');
    assert.ok(Number.isFinite(f.quantile_75), 'quantile_75 finite');
    assert.ok(Number.isFinite(f.iqr_30), 'iqr_30 finite');
    assert.ok(Number.isFinite(f.skewness_30), 'skewness_30 finite');
    assert.ok(Number.isFinite(f.cond_entropy_30), 'cond_entropy_30 finite');
    assert.ok(Number.isFinite(f.trans_prob_to_L), 'trans_prob_to_L finite');
    assert.ok(Number.isFinite(f.surprisal_last), 'surprisal_last finite');
    assert.ok(Number.isFinite(f.run_length_current), 'run_length_current finite');
});

test('features: extractFeaturesFromHistory reconstructs immutable dataset from raw history', () => {
    const { extractFeaturesFromHistory } = require('../game/features');
    const rawHistory = [1.2, 1.5, 2.0, 1.1, 1.8, 3.5, 1.05, 4.0, 1.3, 1.9, 2.2, 1.15];
    const dataset = extractFeaturesFromHistory(rawHistory, 1.3, 5);

    assert.equal(dataset.length, rawHistory.length - 5);
    assert.equal(dataset[0].target, 1.3);
    assert.equal(dataset[0].crash, rawHistory[5]);
    assert.equal(dataset[0].won, rawHistory[5] >= 1.3);
    assert.ok(dataset[0].features.last_1 !== undefined);
});
