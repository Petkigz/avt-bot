'use strict';

/**
 * scripts/dependence-test.js
 *
 * Dedicated Scientific Dependence & Information Laboratory.
 *
 * Answers the fundamental empirical question:
 * "Does the sequence contain statistically detectable information about
 * the next crash multiplier at all?"
 *
 * Tests:
 * 1. Multi-Target Conditional Transition Tests (targets 1.2x to 5.0x) with Holm FWER correction
 * 2. Block Permutation Tests (shuffling contiguous blocks to test sequence ordering)
 * 3. Multi-lag Autocorrelation & Ljung-Box Serial Test on PIT-uniformized transforms
 * 4. 3-State and 5-State Markov Transition Matrices with Chi-Square tests
 * 5. Shannon Mutual Information with permutation null distribution
 * 6. Wald-Wolfowitz Runs Test for non-random clustering
 * 7. Benchmark comparison against Synthetic IID Aviator baseline
 *
 * Usage:
 *   npm run research:dependence-test
 *   node scripts/dependence-test.js [--site betpawa.ug] [--synthetic]
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { analyzeDependence } = require('../research/dependenceLab');
const { createWorld1_PureIid } = require('../sim/syntheticWorlds');

const TARGET_CANDIDATES = [1.20, 1.30, 1.50, 2.00, 3.00, 5.00];

function makeRng(seed = 12345) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * 2-Proportion Z-Test / Chi-square for conditional hit-rate shift.
 */
function testConditionalShift(crashes, target) {
    const n = crashes.length;
    if (n < 30) return null;

    let nAfterLow = 0, hitsAfterLow = 0;
    let nAfterHigh = 0, hitsAfterHigh = 0;
    let totalHits = 0;

    for (let i = 1; i < n; i++) {
        const prev = crashes[i - 1];
        const curr = crashes[i];
        const isHit = curr >= target;
        if (isHit) totalHits++;

        if (prev < target) {
            nAfterLow++;
            if (isHit) hitsAfterLow++;
        } else {
            nAfterHigh++;
            if (isHit) hitsAfterHigh++;
        }
    }

    const baseRate = totalHits / (n - 1);
    const pAfterLow = nAfterLow > 0 ? hitsAfterLow / nAfterLow : baseRate;
    const pAfterHigh = nAfterHigh > 0 ? hitsAfterHigh / nAfterHigh : baseRate;

    // Pooled standard error
    const se = Math.sqrt(baseRate * (1 - baseRate) * (1 / Math.max(1, nAfterLow) + 1 / Math.max(1, nAfterHigh)));
    const z = se > 0 ? (pAfterLow - pAfterHigh) / se : 0;
    // Two-sided p-value from normal approximation
    const pValue = 2 * (1 - normCdf(Math.abs(z)));

    return {
        target,
        baseRate: Number(baseRate.toFixed(4)),
        nAfterLow,
        pAfterLow: Number(pAfterLow.toFixed(4)),
        nAfterHigh,
        pAfterHigh: Number(pAfterHigh.toFixed(4)),
        diff: Number((pAfterLow - pAfterHigh).toFixed(4)),
        z: Number(z.toFixed(3)),
        pValue: Number(pValue.toFixed(4))
    };
}

function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z >= 0 ? 1 - q : q;
}

/**
 * Block Permutation Test for Time-Series Ordering.
 * Shuffles contiguous blocks of size B to test whether observed temporal
 * correlation exceeds permutation null.
 */
function blockPermutationTest(crashes, blockSize = 10, iters = 500, rng = Math.random) {
    const n = crashes.length;
    if (n < 50) return null;

    // Observed lag-1 autocorrelation
    const m = crashes.reduce((s, v) => s + v, 0) / n;
    let varS = 0;
    for (let i = 0; i < n; i++) varS += (crashes[i] - m) ** 2;
    const v = varS / n;
    if (v === 0) return { observedAutocorr: 0, pValue: 1.0 };

    let obsCov = 0;
    for (let i = 0; i < n - 1; i++) obsCov += (crashes[i] - m) * (crashes[i + 1] - m);
    const obsLag1 = obsCov / ((n - 1) * v);

    // Split series into contiguous blocks
    const numBlocks = Math.floor(n / blockSize);
    const blocks = [];
    for (let b = 0; b < numBlocks; b++) {
        blocks.push(crashes.slice(b * blockSize, (b + 1) * blockSize));
    }
    const remainder = crashes.slice(numBlocks * blockSize);

    let extremeCount = 0;
    for (let it = 0; it < iters; it++) {
        // Permute blocks
        const perm = [...blocks];
        for (let i = perm.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        const permuted = [];
        for (const blk of perm) for (const val of blk) permuted.push(val);
        for (const val of remainder) permuted.push(val);

        let permCov = 0;
        for (let i = 0; i < n - 1; i++) permCov += (permuted[i] - m) * (permuted[i + 1] - m);
        const permLag1 = permCov / ((n - 1) * v);

        if (Math.abs(permLag1) >= Math.abs(obsLag1)) extremeCount++;
    }

    const pValue = extremeCount / iters;
    return {
        observedLag1: Number(obsLag1.toFixed(4)),
        blockSize,
        permutations: iters,
        pValue: Number(pValue.toFixed(4)),
        significant: pValue < 0.05
    };
}

/**
 * Runs the complete dependence research test suite on a crash series.
 */
function runFullDependenceSuite(crashes, siteName = 'sample') {
    console.log(`\n========================================================================`);
    console.log(` DEPENDENCE & INFORMATION LAB: ${siteName.toUpperCase()} (N = ${crashes.length} rounds)`);
    console.log(`========================================================================`);

    // 1. Non-ML Dependence Lab Suite
    const depLab = analyzeDependence(crashes);
    if (depLab.error) {
        console.log(`  [INSUFFICIENT DATA] ${depLab.error}`);
        return { error: depLab.error };
    }

    console.log(`\n[1] Probability Integral Transform (PIT) & Ljung-Box Serial Test:`);
    console.log(`    Ljung-Box Q: ${depLab.pit.ljungBox.q} (df=${depLab.pit.ljungBox.df}, p=${depLab.pit.ljungBox.pValue}) -> ${depLab.pit.ljungBox.significant ? 'REJECTS independence (serial dependency detected)' : 'Consistent with pure independence (p > 0.05)'}`);
    console.log(`    PIT Autocorrelations (lags 1-5): [${depLab.pit.autocorr.join(', ')}]`);

    console.log(`\n[2] Markov State Transitions (3-state & 5-state):`);
    if (depLab.markov3) {
        console.log(`    3-State Chi2: ${depLab.markov3.chi2} (df=${depLab.markov3.df}, p=${depLab.markov3.pValue}) -> ${depLab.markov3.independent ? 'No Markov memory' : 'STATISTICALLY SIGNIFICANT Markov memory'}`);
    }

    console.log(`\n[3] Shannon Mutual Information & Information Transfer:`);
    if (depLab.mutualInformation) {
        console.log(`    Mutual Information I(X_t; X_t+1): ${depLab.mutualInformation.mutualInfoBits} bits (Expected null: ${depLab.mutualInformation.expectedNullMIBits} bits)`);
        console.log(`    Permutation p-value: ${depLab.mutualInformation.permutationPValue} -> ${depLab.mutualInformation.significant ? 'Excess information detected' : 'Zero excess information (noise-consistent)'}`);
    }

    console.log(`\n[4] Wald-Wolfowitz Runs Test for Clustering:`);
    if (depLab.runsTest) {
        console.log(`    Observed Runs: ${depLab.runsTest.observedRuns} vs Expected: ${depLab.runsTest.expectedRuns} (Z = ${depLab.runsTest.zScore}, p = ${depLab.runsTest.pValue}) -> ${depLab.runsTest.random ? 'Random clustering' : 'Non-random streak clustering'}`);
    }

    console.log(`\n[5] Multi-Target Conditional Transition Tests (with Holm FWER control):`);
    const targetResults = [];
    for (const t of TARGET_CANDIDATES) {
        const res = testConditionalShift(crashes, t);
        if (res) targetResults.push(res);
    }

    // Apply Holm-Bonferroni correction over target candidate p-values
    const sortedTargets = [...targetResults].sort((a, b) => a.pValue - b.pValue);
    const m = sortedTargets.length;
    let maxAdjP = 0;
    for (let k = 0; k < m; k++) {
        const item = sortedTargets[k];
        const unadjP = item.pValue;
        const adjP = Math.min(1.0, unadjP * (m - k));
        maxAdjP = Math.max(maxAdjP, adjP);
        item.adjustedPValue = Number(maxAdjP.toFixed(4));
        item.significantFwer = maxAdjP < 0.05;
    }

    console.log(`    Target | Base Rate | P(hit|low) | P(hit|high) | Diff   | p (raw) | p (Holm FWER) | Significant`);
    console.log(`    -------+-----------+------------+-------------+--------+---------+---------------+------------`);
    for (const r of targetResults) {
        const sigMark = r.significantFwer ? '[YES]' : 'no';
        console.log(`    ${r.target.toFixed(2)}x  |   ${r.baseRate.toFixed(3)}   |   ${r.pAfterLow.toFixed(3)}    |    ${r.pAfterHigh.toFixed(3)}    | ${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(3)} | ${r.pValue.toFixed(4)}  |    ${r.adjustedPValue.toFixed(4)}     | ${sigMark}`);
    }

    console.log(`\n[6] Block Permutation Test (Temporal Macro-Structure):`);
    const blockPerm = blockPermutationTest(crashes, 10, 500, makeRng(999));
    if (blockPerm) {
        console.log(`    Observed Lag-1 Autocorr: ${blockPerm.observedLag1} (Block size = ${blockPerm.blockSize})`);
        console.log(`    Block Permutation p-value: ${blockPerm.pValue} -> ${blockPerm.significant ? 'Time ordering carries signal' : 'No time-ordering signal over block shuffle'}`);
    }

    const anyFwerSignal = targetResults.some((r) => r.significantFwer);
    const overallVerdict = (depLab.verdict === 'STATISTICALLY_SIGNIFICANT_DEPENDENCE' || anyFwerSignal)
        ? 'DEPENDENCE_DETECTED'
        : 'NO_DEPENDENCE_DETECTED (CONSISTENT WITH IID FAIR STREAM)';

    console.log(`\n========================================================================`);
    console.log(` RESEARCH CONCLUSION: ${overallVerdict}`);
    console.log(`========================================================================\n`);

    return {
        site: siteName,
        verdict: overallVerdict,
        depLab,
        targetResults,
        blockPerm
    };
}

function main() {
    const args = process.argv.slice(2);
    const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
    const runSynthetic = args.includes('--synthetic');

    if (runSynthetic) {
        console.log('Generating 2,000 synthetic pure IID Aviator crash rounds (World 1)...');
        const iidStream = createWorld1_PureIid(2000, 42);
        runFullDependenceSuite(iidStream, 'synthetic_null_world_1');
        return;
    }

    if (!fs.existsSync(config.DATA_DIR)) {
        console.log(`Data directory ${config.DATA_DIR} does not exist. Running on synthetic baseline.`);
        const iidStream = createWorld1_PureIid(2000, 42);
        runFullDependenceSuite(iidStream, 'synthetic_null_world_1');
        return;
    }

    const files = fs.readdirSync(config.DATA_DIR).filter((f) => /^history-.*\.json$/.test(f));
    const targetFiles = files.filter((f) => !siteArg || f === `history-${siteArg}.json`);

    if (targetFiles.length === 0) {
        console.log('No recorded site history files found in data directory.');
        console.log('Running test against synthetic IID Aviator stream for demonstration...\n');
        const iidStream = createWorld1_PureIid(2000, 42);
        runFullDependenceSuite(iidStream, 'synthetic_null_world_1');
        return;
    }

    for (const file of targetFiles) {
        const fullPath = path.join(config.DATA_DIR, file);
        try {
            const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            const values = Array.isArray(raw) ? raw : (raw.values || []);
            const siteName = file.replace(/^history-/, '').replace(/\.json$/, '');
            runFullDependenceSuite(values, siteName);
        } catch (err) {
            console.error(`Error reading ${file}: ${err.message}`);
        }
    }
}

if (require.main === module) main();

module.exports = {
    runFullDependenceSuite,
    testConditionalShift,
    blockPermutationTest
};
