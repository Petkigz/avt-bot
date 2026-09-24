'use strict';

/**
 * scripts/research-benchmark.js
 *
 * Adversarial Scientific Research Benchmark.
 * Evaluates the entire intelligence and discovery stack across controlled
 * synthetic worlds with known ground-truth statistical properties.
 *
 * Benchmarks:
 * 1. World 1 (Pure IID Noise)        -> Zero False Positive Discoveries
 * 2. World 2 (Markov Dependency)    -> Dependency Detection Power
 * 3. World 3 (Regime Switching)     -> Conditional Distribution Shift Detection
 * 4. World 4 (Microstructure)       -> Early Flight Trajectory Discovery
 * 5. World 5 (Planted Signal)       -> 3-Tier Hypothesis Engine Discovery & Confirmation
 * 6. World 6 (Decaying Trap)        -> Edge Decay Detection & Lifecycle Retirement
 *
 * Usage:
 *   npm run research:benchmark
 *   node scripts/research-benchmark.js
 */

const {
    createWorld1_PureIid,
    createWorld2_MarkovDependency,
    createWorld3_RegimeSwitching,
    createWorld4_TrajectoryTraces,
    createWorld5_PatternSignal,
    createWorld6_DecayingSignal
} = require('../sim/syntheticWorlds');

const { analyzeDependence } = require('../research/dependenceLab');
const { analyzeDistribution } = require('../research/distributionLab');
const { analyzeTrajectories } = require('../research/trajectoryLab');
const { runHypothesisEngine } = require('../research/hypothesisEngine');
const { SignalLifecycle } = require('../game/signalLifecycle');

function runBenchmark() {
    console.log('========================================================================');
    console.log(' ADVERSARIAL SCIENTIFIC RESEARCH BENCHMARK');
    console.log('========================================================================\n');

    const results = [];
    let passedTests = 0;
    let totalTests = 0;

    // -------------------------------------------------------------------------
    // World 1: Pure IID Noise (False Positive Resistance Benchmark)
    // -------------------------------------------------------------------------
    totalTests += 4;
    console.log('[WORLD 1] Pure IID Aviator Noise (Null Model):');
    const w1Stream = createWorld1_PureIid(1200, 101);
    const w1Dep = analyzeDependence(w1Stream, { miIters: 150 });
    const w1Dist = analyzeDistribution(w1Stream, { iters: 150 });
    const w1Hyp = runHypothesisEngine(w1Stream);

    const w1DepPass = w1Dep.verdict === 'NO_DEPENDENCE_DETECTED';
    const w1DistPass = w1Dist.verdict === 'NO_CONDITIONAL_SHIFT_DETECTED_FOR_TESTED_CONDITIONS';
    const w1HypPass = w1Hyp.tier3HoldoutConfirmed === 0;
    const w1FdrPass = w1Dep.confirmedFdrFlags.length === 0;

    if (w1DepPass) passedTests++;
    if (w1DistPass) passedTests++;
    if (w1HypPass) passedTests++;
    if (w1FdrPass) passedTests++;

    console.log(`  ├─ Dependence Lab:       ${w1Dep.verdict} [${w1DepPass ? 'PASS' : 'FAIL'}]`);
    console.log(`  ├─ FDR Correction:       ${w1Dep.confirmedFdrFlags.length} false alarms [${w1FdrPass ? 'PASS' : 'FAIL'}]`);
    console.log(`  ├─ Distribution Lab:     ${w1Dist.verdict} [${w1DistPass ? 'PASS' : 'FAIL'}]`);
    console.log(`  └─ Hypothesis Engine:    ${w1Hyp.tier3HoldoutConfirmed} confirmed signals (expected 0) [${w1HypPass ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 2: Markov Transition Dependency (Signal Detection Power)
    // -------------------------------------------------------------------------
    totalTests += 1;
    console.log('\n[WORLD 2] First-Order Markov Transition Dependency:');
    const w2Stream = createWorld2_MarkovDependency(1000, 202);
    const w2Dep = analyzeDependence(w2Stream, { miIters: 150 });
    const w2Pass = w2Dep.verdict === 'STATISTICALLY_SIGNIFICANT_DEPENDENCE' || !w2Dep.markov3.independent;
    if (w2Pass) passedTests++;
    console.log(`  └─ Markov Permutation:   Chi2=${w2Dep.markov3 ? w2Dep.markov3.chi2 : 'n/a'} (p=${w2Dep.markov3 ? w2Dep.markov3.permutationPValue : 'n/a'}) [${w2Pass ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 3: Hidden Regime Switching (Distributional Shift Detection)
    // -------------------------------------------------------------------------
    totalTests += 1;
    console.log('\n[WORLD 3] Hidden Regime Switching:');
    const w3Stream = createWorld3_RegimeSwitching(1200, 303);
    const w3Dist = analyzeDistribution(w3Stream, { iters: 150 });
    const w3Pass = w3Dist.verdict === 'CONDITIONAL_DISTRIBUTION_SHIFT_CANDIDATE' || w3Dist.flags.length > 0;
    if (w3Pass) passedTests++;
    console.log(`  └─ 2-Sample KS/W Test:   ${w3Dist.verdict} (flags: ${w3Dist.flags.length}) [${w3Pass ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 4: Microstructure Flight Trajectory Correlation
    // -------------------------------------------------------------------------
    totalTests += 1;
    console.log('\n[WORLD 4] Early Flight Trajectory Microstructure:');
    const w4Traces = createWorld4_TrajectoryTraces(300, 404);
    const w4Traj = analyzeTrajectories(w4Traces);
    const w4Pass = w4Traj.verdict === 'MICROSTRUCTURE_DEPENDENCE_CANDIDATE';
    if (w4Pass) passedTests++;
    console.log(`  └─ Early Curve Analysis: ${w4Traj.verdict} [${w4Pass ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 5: Genuine Planted Conditional Signal Discovery
    // -------------------------------------------------------------------------
    totalTests += 2;
    console.log('\n[WORLD 5] Planted Conditional Signal (LLH -> 1.50x @ 92%):');
    const w5Stream = createWorld5_PatternSignal(2000, 505);
    const w5Hyp = runHypothesisEngine(w5Stream);
    const w5DiscoveryPass = w5Hyp.tier1Discovered >= 1;
    const w5HoldoutPass = w5Hyp.tier3HoldoutConfirmed >= 1;
    if (w5DiscoveryPass) passedTests++;
    if (w5HoldoutPass) passedTests++;
    console.log(`  ├─ Discovery Tier 1:     ${w5Hyp.tier1Discovered} candidates passed FDR filter [${w5DiscoveryPass ? 'PASS' : 'FAIL'}]`);
    console.log(`  └─ Holdout Tier 3:       ${w5Hyp.tier3HoldoutConfirmed} candidates CONFIRMED on locked holdout [${w5HoldoutPass ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 6: Decaying / Transient Pattern Trap (Lifecycle Retirement)
    // -------------------------------------------------------------------------
    totalTests += 1;
    console.log('\n[WORLD 6] Decaying Pattern Trap (Signal dies after round 600):');
    const w6Stream = createWorld6_DecayingSignal(1500, 606);
    const w6Hyp = runHypothesisEngine(w6Stream);
    const w6Pass = w6Hyp.tier3HoldoutConfirmed === 0;
    if (w6Pass) passedTests++;
    console.log(`  └─ Decay Resistance:     Holdout rejected decayed signal (confirmed: ${w6Hyp.tier3HoldoutConfirmed}) [${w6Pass ? 'PASS' : 'FAIL'}]`);

    console.log('\n========================================================================');
    console.log(` SCIENTIFIC BENCHMARK SCORE: ${passedTests}/${totalTests} TESTS PASSED (${((passedTests / totalTests) * 100).toFixed(1)}%)`);
    console.log('========================================================================');

    return {
        passedTests,
        totalTests,
        success: passedTests === totalTests
    };
}

if (require.main === module) runBenchmark();

module.exports = { runBenchmark };
