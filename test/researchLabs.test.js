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
    adjustBenjaminiHochberg,
    analyzeDependence
} = require('../research/dependenceLab');
const {
    survivalCurve,
    ksStatistic,
    wassersteinDistance,
    twoSamplePermutationTest,
    analyzeDistribution
} = require('../research/distributionLab');
const {
    analyzeTrajectories
} = require('../research/trajectoryLab');
const {
    createWorld1_PureIid,
    createWorld2_MarkovDependency,
    createWorld3_RegimeSwitching,
    createWorld4_TrajectoryTraces
} = require('../sim/syntheticWorlds');

test('dependenceLab: pure IID stream is identified as NO_DEPENDENCE_DETECTED', () => {
    const iid = createWorld1_PureIid(800, 777);
    const res = analyzeDependence(iid, { miIters: 150 });
    assert.strictEqual(res.verdict, 'NO_DEPENDENCE_DETECTED');
    assert.strictEqual(res.confirmedFdrFlags.length, 0);
    assert.ok(res.runsTest && res.runsTest.random, 'runs test should be random');
    assert.ok(res.pit.ljungBox && !res.pit.ljungBox.significant, 'PIT Ljung-Box should not be significant');
});

test('dependenceLab: Markov-dependent stream is flagged as STATISTICALLY_SIGNIFICANT_DEPENDENCE', () => {
    const dependent = createWorld2_MarkovDependency(800, 888);
    const res = analyzeDependence(dependent, { miIters: 150 });
    assert.strictEqual(res.verdict, 'STATISTICALLY_SIGNIFICANT_DEPENDENCE');
    assert.ok(res.nominalFlags.length >= 1 || res.confirmedFdrFlags.length >= 1, 'at least one test must flag dependence');
    assert.ok(!res.markov3.independent, 'Markov test must reject independence');
});

test('PIT transform maps values to (0, 1) and diffuses 1.00 atom', () => {
    const vals = [1.00, 1.00, 1.30, 2.00, 10.00];
    const pit = pitTransform(vals, 0.05);
    assert.strictEqual(pit.length, 5);
    pit.forEach((p) => {
        assert.ok(p >= 0 && p <= 1, `PIT value must be in [0,1], got ${p}`);
    });
    // First two 1.00 values should be randomized continuous variables in [0, 0.05]
    assert.notStrictEqual(pit[0], pit[1], 'discrete 1.00 atom should be randomized to prevent discrete spike artifact');
});

test('autocorrelation detects known lag-1 correlation', () => {
    const periodic = [];
    for (let i = 0; i < 200; i++) periodic.push(i % 2 === 0 ? 1 : -1);
    const acf = autocorrelation(periodic, 3);
    assert.ok(acf[0] < -0.9, `lag-1 autocorrelation must be strongly negative, got ${acf[0]}`);
    assert.ok(acf[1] > 0.9, `lag-2 autocorrelation must be strongly positive, got ${acf[1]}`);
});

test('adjustBenjaminiHochberg FDR correctly adjusts p-values', () => {
    const pVals = [0.001, 0.010, 0.040, 0.200];
    const adjusted = adjustBenjaminiHochberg(pVals);
    assert.strictEqual(adjusted.length, 4);
    assert.ok(adjusted[0] <= adjusted[1]);
    assert.ok(adjusted[0] < 0.05);
    assert.ok(adjusted[3] >= 0.20);
});

test('distributionLab: stationary IID stream reports NO_CONDITIONAL_SHIFT_DETECTED', () => {
    const iid = createWorld1_PureIid(800, 999);
    const res = analyzeDistribution(iid, { iters: 150 });
    assert.strictEqual(res.verdict, 'NO_CONDITIONAL_SHIFT_DETECTED_FOR_TESTED_CONDITIONS');
    assert.strictEqual(res.flags.length, 0);
    assert.ok(res.tests.afterLowVsHigh.ksPValue > 0.01, 'conditional KS p-value should be > 0.01');
});

test('distributionLab: regime-switched stream detects conditional distribution shift candidate', () => {
    const switched = createWorld3_RegimeSwitching(1000, 321);
    const res = analyzeDistribution(switched, { iters: 150 });
    assert.strictEqual(res.verdict, 'CONDITIONAL_DISTRIBUTION_SHIFT_CANDIDATE');
    assert.ok(res.flags.length >= 1, 'at least one conditional comparison must flag shift');
});

test('trajectoryLab: analyzes flight curves, velocity, and early milestone survival', () => {
    const traces = createWorld4_TrajectoryTraces(300, 404);
    const res = analyzeTrajectories(traces);
    assert.strictEqual(res.n, 300);
    assert.ok(res.timeTo12Analysis, 'timeTo12 milestone analysis exists');
    assert.ok(res.timeTo12Analysis.sampleFast > 0);
    assert.ok(res.timeTo12Analysis.sampleSlow > 0);
    // World 4 specifically injects timeTo12 correlation with 2.0x survival
    assert.strictEqual(res.verdict, 'MICROSTRUCTURE_DEPENDENCE_CANDIDATE');
});
