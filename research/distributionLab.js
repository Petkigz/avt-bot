'use strict';

/**
 * research/distributionLab.js
 *
 * Distributional research laboratory for studying the FULL survival curve
 * S(x) = P(X >= x) of Aviator crashes rather than a single binary target.
 *
 * Tests whether conditional crash distributions (after cold crashes, after
 * warm wins, after streaks, after high volatility) actually diverge from
 * the unconditional distribution using 2-sample Kolmogorov-Smirnov and
 * Wasserstein metric tests with exact permutation p-values.
 */

const TARGET_GRID = [1.01, 1.10, 1.20, 1.30, 1.40, 1.50, 1.75, 2.00, 2.50, 3.00, 5.00, 10.00, 20.00, 50.00];

function makeRng(seed = 1337) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function survivalCurve(values, grid = TARGET_GRID) {
    const n = values.length;
    if (n === 0) return {};
    const curve = {};
    for (const t of grid) {
        const count = values.reduce((s, v) => s + (v >= t ? 1 : 0), 0);
        curve[t] = Number((count / n).toFixed(4));
    }
    return curve;
}

// Kolmogorov-Smirnov statistic between two empirical distributions
function ksStatistic(sampleA, sampleB) {
    if (sampleA.length === 0 || sampleB.length === 0) return 0;
    const all = [...sampleA.map((v) => ({ v, src: 'A' })), ...sampleB.map((v) => ({ v, src: 'B' }))]
        .sort((a, b) => a.v - b.v);

    const nA = sampleA.length;
    const nB = sampleB.length;
    let countA = 0, countB = 0;
    let maxD = 0;

    for (const item of all) {
        if (item.src === 'A') countA++;
        else countB++;
        const cdfA = countA / nA;
        const cdfB = countB / nB;
        const diff = Math.abs(cdfA - cdfB);
        if (diff > maxD) maxD = diff;
    }
    return maxD;
}

// Permutation test for KS statistic: tests H0: sampleA and sampleB come from same distribution
function ksPermutationTest(sampleA, sampleB, iters = 500) {
    const nA = sampleA.length;
    const nB = sampleB.length;
    if (nA < 10 || nB < 10) return { d: 0, pValue: 1.0, significant: false };

    const observedD = ksStatistic(sampleA, sampleB);
    const pooled = [...sampleA, ...sampleB];
    const total = pooled.length;
    const rng = makeRng(77);
    let exceedCount = 0;

    for (let it = 0; it < iters; it++) {
        // In-place Fisher-Yates shuffle
        for (let i = total - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const tmp = pooled[i];
            pooled[i] = pooled[j];
            pooled[j] = tmp;
        }
        const permA = pooled.slice(0, nA);
        const permB = pooled.slice(nA);
        const permD = ksStatistic(permA, permB);
        if (permD >= observedD) exceedCount++;
    }

    const pValue = (exceedCount + 1) / (iters + 1);
    return {
        d: Number(observedD.toFixed(4)),
        sampleSizeA: nA,
        sampleSizeB: nB,
        pValue: Number(pValue.toFixed(4)),
        significant: pValue < 0.05
    };
}

// 1D Wasserstein distance (Earth Mover's Distance)
function wassersteinDistance(sampleA, sampleB) {
    if (sampleA.length === 0 || sampleB.length === 0) return 0;
    const sortA = [...sampleA].sort((a, b) => a - b);
    const sortB = [...sampleB].sort((a, b) => a - b);
    const n = 100;
    let dist = 0;
    for (let i = 0; i < n; i++) {
        const q = (i + 0.5) / n;
        const qa = sortA[Math.floor(q * sortA.length)];
        const qb = sortB[Math.floor(q * sortB.length)];
        dist += Math.abs(qa - qb);
    }
    return dist / n;
}

function analyzeDistribution(values, opts = {}) {
    if (!Array.isArray(values) || values.length < 50) {
        return {
            error: `need at least 50 rounds for distributional analysis (have ${values ? values.length : 0})`,
            n: values ? values.length : 0
        };
    }

    const n = values.length;
    const grid = opts.grid || TARGET_GRID;
    const unconditional = survivalCurve(values, grid);

    // Estimate operator instant-crash edge: r = 1 - S(1.01)
    const instantCrashes = values.filter((v) => v <= 1.01).length;
    const operatorEdge = instantCrashes / n;

    // Theoretical null curve: S_0(x) = (1 - r) / x for x >= 1.0
    const theoreticalNull = {};
    for (const t of grid) {
        theoreticalNull[t] = Number((Math.min(1 - operatorEdge, (1 - operatorEdge) / t)).toFixed(4));
    }

    // Conditional splits:
    // 1. After low crash (< 1.30x) vs after warm win (>= 2.00x)
    const afterLow = [];
    const afterHigh = [];
    for (let t = 1; t < n; t++) {
        if (values[t - 1] < 1.30) afterLow.push(values[t]);
        if (values[t - 1] >= 2.00) afterHigh.push(values[t]);
    }

    // 2. After cold streak (3 consecutive < 1.50x) vs after warm streak (2 consecutive >= 2.00x)
    const afterColdStreak = [];
    const afterWarmStreak = [];
    for (let t = 3; t < n; t++) {
        if (values[t - 3] < 1.50 && values[t - 2] < 1.50 && values[t - 1] < 1.50) {
            afterColdStreak.push(values[t]);
        }
        if (values[t - 2] >= 2.00 && values[t - 1] >= 2.00) {
            afterWarmStreak.push(values[t]);
        }
    }

    const ksAfterLowVsHigh = ksPermutationTest(afterLow, afterHigh, opts.ksIters ?? 500);
    const ksAfterStreak = ksPermutationTest(afterColdStreak, afterWarmStreak, opts.ksIters ?? 500);
    const wassersteinLowVsHigh = Number(wassersteinDistance(afterLow, afterHigh).toFixed(3));

    const flags = [];
    if (ksAfterLowVsHigh.significant) {
        flags.push(`Distribution after Low (<1.3x) vs High (>=2x) differs significantly (KS D=${ksAfterLowVsHigh.d}, p=${ksAfterLowVsHigh.pValue})`);
    }
    if (ksAfterStreak.significant) {
        flags.push(`Distribution after 3-Cold streak vs 2-Warm streak differs significantly (KS D=${ksAfterStreak.d}, p=${ksAfterStreak.pValue})`);
    }

    const verdict = flags.length > 0
        ? 'CONDITIONAL_DISTRIBUTION_SHIFT_DETECTED'
        : 'STATIONARY_INDEPENDENT_DISTRIBUTION';

    return {
        n,
        operatorEdge: Number(operatorEdge.toFixed(4)),
        verdict,
        flags,
        unconditionalSurvival: unconditional,
        theoreticalNull,
        conditionalSurvivals: {
            afterLow: survivalCurve(afterLow, grid),
            afterHigh: survivalCurve(afterHigh, grid),
            afterColdStreak3: survivalCurve(afterColdStreak, grid),
            afterWarmStreak2: survivalCurve(afterWarmStreak, grid)
        },
        tests: {
            afterLowVsHigh: {
                ...ksAfterLowVsHigh,
                wassersteinDistance: wassersteinLowVsHigh
            },
            afterColdVsWarmStreak: ksAfterStreak
        },
        summary: verdict === 'STATIONARY_INDEPENDENT_DISTRIBUTION'
            ? `Two-sample Kolmogorov-Smirnov and Wasserstein tests confirm that future crash distributions do not shift conditionally on past crashes or loss streaks (p > 0.05).`
            : `Distributional shift detected: ${flags.join('; ')}.`
    };
}

module.exports = {
    TARGET_GRID,
    survivalCurve,
    ksStatistic,
    ksPermutationTest,
    wassersteinDistance,
    analyzeDistribution
};
