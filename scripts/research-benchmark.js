'use strict';

/**
 * scripts/research-benchmark.js
 *
 * Adversarial Scientific Research Benchmark Suite.
 * Evaluates the entire intelligence and discovery stack across repeated multi-seed
 * trials in controlled synthetic worlds with known ground-truth statistical properties.
 *
 * Benchmarks:
 * 1. World 1 (Pure IID Noise)        -> 100% False-Positive Rejection Rate
 * 2. World 2 (Markov Dependency)    -> Dependency Detection Power
 * 3. World 3 (Regime Switching)     -> Conditional Distribution Shift Detection
 * 4. World 4 (Microstructure)       -> Early Flight Trajectory Discovery
 * 5. World 5 (Planted Signal)       -> 3-Tier Hypothesis Engine Discovery & Confirmation
 * 6. World 6 (Decaying Trap)        -> Edge Decay Detection & Complete Lifecycle Retirement
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

function runBenchmark(opts = {}) {
    const trials = opts.trials || 5;
    console.log('========================================================================');
    console.log(' ADVERSARIAL MULTI-TRIAL SCIENTIFIC RESEARCH BENCHMARK');
    console.log(` (Evaluating across ${trials} distinct randomized seeds per controlled world)`);
    console.log('========================================================================\n');

    let totalChecks = 0;
    let passedChecks = 0;

    // -------------------------------------------------------------------------
    // World 1: Pure IID Noise (False Positive Resistance across multiple seeds)
    // -------------------------------------------------------------------------
    console.log('[WORLD 1] Pure IID Aviator Noise (Null Model):');
    let w1DepPasses = 0;
    let w1FdrPasses = 0;
    let w1DistPasses = 0;
    let w1HypPasses = 0;

    for (let t = 0; t < trials; t++) {
        const seed = 100 + t * 37;
        const stream = createWorld1_PureIid(1200, seed);
        const dep = analyzeDependence(stream, { miIters: 100 });
        const dist = analyzeDistribution(stream, { iters: 100 });
        const hyp = runHypothesisEngine(stream);

        if (dep.verdict === 'NO_DEPENDENCE_DETECTED') w1DepPasses++;
        if (dep.confirmedFdrFlags.length === 0) w1FdrPasses++;
        if (dist.verdict === 'NO_CONDITIONAL_SHIFT_DETECTED_FOR_TESTED_CONDITIONS') w1DistPasses++;
        if (hyp.tier3HoldoutConfirmed === 0) w1HypPasses++;
    }

    totalChecks += 4;
    const w1DepOk = w1DepPasses >= Math.floor(trials * 0.8);
    const w1FdrOk = w1FdrPasses === trials;
    const w1DistOk = w1DistPasses >= Math.floor(trials * 0.8);
    const w1HypOk = w1HypPasses === trials;

    if (w1DepOk) passedChecks++;
    if (w1FdrOk) passedChecks++;
    if (w1DistOk) passedChecks++;
    if (w1HypOk) passedChecks++;

    console.log(`  ├─ Dependence Lab:       ${w1DepPasses}/${trials} trials NO_DEPENDENCE_DETECTED [${w1DepOk ? 'PASS' : 'FAIL'}]`);
    console.log(`  ├─ FDR Correction:       ${w1FdrPasses}/${trials} trials 0 false alarms (100% FPR rejection) [${w1FdrOk ? 'PASS' : 'FAIL'}]`);
    console.log(`  ├─ Distribution Lab:     ${w1DistPasses}/${trials} trials NO_CONDITIONAL_SHIFT [${w1DistOk ? 'PASS' : 'FAIL'}]`);
    console.log(`  └─ Hypothesis Engine:    ${w1HypPasses}/${trials} trials 0 false confirmations [${w1HypOk ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 2: Markov Transition Dependency (Power Test)
    // -------------------------------------------------------------------------
    console.log('\n[WORLD 2] First-Order Markov Transition Dependency:');
    let w2Passes = 0;
    for (let t = 0; t < trials; t++) {
        const seed = 200 + t * 43;
        const stream = createWorld2_MarkovDependency(1000, seed);
        const dep = analyzeDependence(stream, { miIters: 100 });
        if (dep.verdict === 'STATISTICALLY_SIGNIFICANT_DEPENDENCE' || !dep.markov3.independent) w2Passes++;
    }
    totalChecks += 1;
    const w2Ok = w2Passes === trials;
    if (w2Ok) passedChecks++;
    console.log(`  └─ Markov Detection:     ${w2Passes}/${trials} trials detected Markov structure [${w2Ok ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 3: Hidden Regime Switching (Shift Detection Test)
    // -------------------------------------------------------------------------
    console.log('\n[WORLD 3] Hidden Regime Switching:');
    let w3Passes = 0;
    for (let t = 0; t < trials; t++) {
        const seed = 300 + t * 51;
        const stream = createWorld3_RegimeSwitching(1200, seed);
        const dist = analyzeDistribution(stream, { iters: 100 });
        if (dist.verdict === 'CONDITIONAL_DISTRIBUTION_SHIFT_CANDIDATE' || dist.flags.length > 0) w3Passes++;
    }
    totalChecks += 1;
    const w3Ok = w3Passes === trials;
    if (w3Ok) passedChecks++;
    console.log(`  └─ Shift Detection:      ${w3Passes}/${trials} trials detected distribution shift [${w3Ok ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 4: Microstructure Flight Trajectory Correlation
    // -------------------------------------------------------------------------
    console.log('\n[WORLD 4] Early Flight Trajectory Microstructure:');
    let w4Passes = 0;
    for (let t = 0; t < trials; t++) {
        const seed = 400 + t * 29;
        const traces = createWorld4_TrajectoryTraces(300, seed);
        const traj = analyzeTrajectories(traces);
        if (traj.verdict === 'MICROSTRUCTURE_DEPENDENCE_CANDIDATE') w4Passes++;
    }
    totalChecks += 1;
    const w4Ok = w4Passes >= Math.floor(trials * 0.8);
    if (w4Ok) passedChecks++;
    console.log(`  └─ Curve Analysis:       ${w4Passes}/${trials} trials detected microstructure correlation [${w4Ok ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 5: Genuine Planted Conditional Signal Discovery
    // -------------------------------------------------------------------------
    console.log('\n[WORLD 5] Planted Conditional Signal (LLH -> 1.50x @ 92%):');
    let w5DiscoveryPasses = 0;
    let w5HoldoutPasses = 0;
    for (let t = 0; t < trials; t++) {
        const seed = 500 + t * 31;
        const stream = createWorld5_PatternSignal(2000, seed);
        const hyp = runHypothesisEngine(stream);
        if (hyp.tier1Discovered >= 1) w5DiscoveryPasses++;
        if (hyp.tier3HoldoutConfirmed >= 1) w5HoldoutPasses++;
    }
    totalChecks += 2;
    const w5DiscOk = w5DiscoveryPasses === trials;
    const w5HoldOk = w5HoldoutPasses === trials;
    if (w5DiscOk) passedChecks++;
    if (w5HoldOk) passedChecks++;
    console.log(`  ├─ Discovery Tier 1:     ${w5DiscoveryPasses}/${trials} trials passed discovery [${w5DiscOk ? 'PASS' : 'FAIL'}]`);
    console.log(`  └─ Holdout Tier 3:       ${w5HoldoutPasses}/${trials} trials CONFIRMED on locked holdout [${w5HoldOk ? 'PASS' : 'FAIL'}]`);

    // -------------------------------------------------------------------------
    // World 6: Edge Decay Detection & Complete Lifecycle Retirement
    // -------------------------------------------------------------------------
    console.log('\n[WORLD 6] Edge Decay Detection & Complete Lifecycle Retirement:');
    totalChecks += 2;

    // Test 6a: Hypothesis Engine rejects decayed signal on holdout
    let w6HoldoutRejections = 0;
    for (let t = 0; t < trials; t++) {
        const seed = 600 + t * 17;
        const stream = createWorld6_DecayingSignal(1500, seed);
        const hyp = runHypothesisEngine(stream);
        if (hyp.tier3HoldoutConfirmed === 0) w6HoldoutRejections++;
    }
    const w6HoldoutOk = w6HoldoutRejections === trials;
    if (w6HoldoutOk) passedChecks++;
    console.log(`  ├─ Holdout Rejection:    ${w6HoldoutRejections}/${trials} trials rejected decayed signal [${w6HoldoutOk ? 'PASS' : 'FAIL'}]`);

    // Test 6b: SignalLifecycle state machine tracks decay and retires candidate
    const testLife = new SignalLifecycle('benchmark_decay_test');
    testLife.candidates = [
        {
            id: 'prior_low_crash_target_1.3',
            name: 'Decaying Test Pattern',
            target: 1.30,
            status: 'LIVE_SHADOW',
            liveStats: {
                triggeredCount: 30,
                wins: 25,
                losses: 5,
                consecutiveLosses: 0,
                currentLift: 0.15,
                evAccumulated: 3.5
            }
        }
    ];

    // Promote to LIVE_MICRO
    const dummyHistory = [1.50, 2.00, 1.10];
    testLife.onRoundEnded(dummyHistory, 1.45);
    const promoted = testLife.candidates[0].status === 'LIVE_MICRO';

    // Inject deteriorating loss streak
    for (let i = 0; i < 9; i++) {
        testLife.onRoundEnded(dummyHistory, 1.10); // Loss
    }
    const retired = testLife.candidates[0].status === 'RETIRED';
    const w6LifecycleOk = promoted && retired;
    if (w6LifecycleOk) passedChecks++;
    console.log(`  └─ Lifecycle Engine:     ${promoted ? 'PROMOTED' : 'NOT_PROMOTED'} -> ${retired ? 'RETIRED' : 'ACTIVE'} [${w6LifecycleOk ? 'PASS' : 'FAIL'}]`);

    console.log('\n========================================================================');
    console.log(` SCIENTIFIC BENCHMARK SCORE: ${passedChecks}/${totalChecks} CHECKS PASSED (${((passedChecks / totalChecks) * 100).toFixed(1)}%)`);
    console.log('========================================================================');

    return {
        passedChecks,
        totalChecks,
        success: passedChecks === totalChecks
    };
}

if (require.main === module) runBenchmark();

module.exports = { runBenchmark };
