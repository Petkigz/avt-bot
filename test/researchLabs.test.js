'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    pitTransform,
    autocorrelation,
    ljungBoxTest,
    markovAnalysis,
    mutualInformationAnalysis,
    runsTest,
    analyzeDependence
} = require('../research/dependenceLab');
const {
    survivalCurve,
    ksStatistic,
    ksPermutationTest,
    analyzeDistribution
} = require('../research/distributionLab');

function makeRng(seed = 999) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// Generate pure IID synthetic Aviator crashes: 96% survival with S(x) = 0.96 / x
function generateIidCrashes(n, seed = 123) {
    const rng = makeRng(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        const u = rng();
        if (u < 0.04) out.push(1.00); // 4% instant crash
        else {
            const v = (u - 0.04) / 0.96;
            out.push(Math.max(1.01, 1 / (1 - v + 1e-9)));
        }
    }
    return out;
}

// Generate Markov-dependent crashes: low crashes tend to follow low crashes
function generateMarkovCrashes(n, seed = 456) {
    const rng = makeRng(seed);
    const out = [];
    let state = 0; // 0 = low, 1 = high
    for (let i = 0; i < n; i++) {
        // Sticky transition: 75% chance of staying in current state
        if (rng() < 0.25) state = 1 - state;
        if (state === 0) {
            out.push(1.05 + rng() * 0.35); // crash in [1.05, 1.40]
        } else {
            out.push(2.10 + rng() * 4.0); // crash in [2.10, 6.10]
        }
    }
    return out;
}

test('dependenceLab: pure IID stream is identified as INDEPENDENT_RANDOM_STREAM', () => {
    const iid = generateIidCrashes(800, 777);
    const res = analyzeDependence(iid, { miIters: 200 });
    assert.strictEqual(res.verdict, 'INDEPENDENT_RANDOM_STREAM');
    assert.strictEqual(res.flags.length, 0);
    assert.ok(res.runsTest && res.runsTest.random, 'runs test should be random');
    assert.ok(res.pit.ljungBox && !res.pit.ljungBox.significant, 'PIT Ljung-Box should not be significant');
});

test('dependenceLab: Markov-dependent stream is flagged as NON_RANDOM_DEPENDENCE_DETECTED', () => {
    const dependent = generateMarkovCrashes(600, 888);
    const res = analyzeDependence(dependent, { miIters: 200 });
    assert.strictEqual(res.verdict, 'NON_RANDOM_DEPENDENCE_DETECTED');
    assert.ok(res.flags.length >= 1, 'at least one test must flag dependence');
    assert.ok(!res.markov3.independent, 'Markov test must reject independence');
});

test('PIT transform maps values to (0, 1)', () => {
    const vals = [1.00, 1.30, 2.00, 10.00];
    const pit = pitTransform(vals, 0.04);
    assert.strictEqual(pit.length, 4);
    pit.forEach((p) => assert.ok(p >= 0 && p <= 1, `PIT value must be in [0,1], got ${p}`));
});

test('autocorrelation detects known lag-1 correlation', () => {
    const periodic = [];
    for (let i = 0; i < 200; i++) periodic.push(i % 2 === 0 ? 1 : -1);
    const acf = autocorrelation(periodic, 3);
    assert.ok(acf[0] < -0.9, `lag-1 autocorrelation must be strongly negative, got ${acf[0]}`);
    assert.ok(acf[1] > 0.9, `lag-2 autocorrelation must be strongly positive, got ${acf[1]}`);
});

test('distributionLab: stationary IID stream is identified as STATIONARY_INDEPENDENT_DISTRIBUTION', () => {
    const iid = generateIidCrashes(800, 999);
    const res = analyzeDistribution(iid, { ksIters: 200 });
    assert.strictEqual(res.verdict, 'STATIONARY_INDEPENDENT_DISTRIBUTION');
    assert.strictEqual(res.flags.length, 0);
    assert.ok(res.tests.afterLowVsHigh.pValue > 0.05, 'conditional KS p-value should be > 0.05');
});

test('distributionLab: regime-switched stream detects conditional distribution shift', () => {
    const dependent = generateMarkovCrashes(600, 321);
    const res = analyzeDistribution(dependent, { ksIters: 200 });
    assert.strictEqual(res.verdict, 'CONDITIONAL_DISTRIBUTION_SHIFT_DETECTED');
    assert.ok(res.tests.afterLowVsHigh.significant, 'KS test must flag distribution difference');
});
