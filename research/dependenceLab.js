'use strict';

/**
 * research/dependenceLab.js
 *
 * Scientific dependence laboratory for testing whether an Aviator multiplier
 * sequence exhibits ANY non-random serial structure, after removing the
 * known marginal distribution.
 *
 * Methods:
 * 1. Randomized Probability Integral Transform (PIT) uniformization:
 *    transforms continuous crash outcomes into U(0,1) and properly randomizes
 *    the discrete atom at instant crashes (1.00x) so U ~ Uniform(0,1) under null.
 * 2. Autocorrelation & Ljung-Box test across multiple representations:
 *    raw, log(X), PIT(X), 1(X >= 1.30), 1(X >= 2.00).
 * 3. Markov State Transition Matrix (3-state terciles + 5-state quintiles)
 *    with time-series permutation test for independence.
 * 4. Shannon Mutual Information & Conditional Entropy with Permutation Test.
 * 5. Wald-Wolfowitz Runs Test for non-random clustering.
 * 6. Benjamini-Hochberg False Discovery Rate (FDR) Multiple-Testing Correction.
 */

function makeRng(seed = 42) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// 1. Randomized PIT Transform: continuous U(0,1) under null S(x) = (1-r)/x
// ---------------------------------------------------------------------------
function pitTransform(values, instantCrashRate = 0.04, rng = makeRng(88)) {
    const r = Math.min(0.2, Math.max(0.01, instantCrashRate));
    return values.map((x) => {
        if (!Number.isFinite(x) || x <= 1.001) {
            // Properly randomized discrete atom: uniform within [0, r)
            return Math.min(0.9999, Math.max(0.0001, r * rng()));
        }
        // Continuous part: F(x) = r + (1-r)*(1 - 1/x)
        const cdf = r + (1 - r) * (1 - 1 / x);
        return Math.min(0.9999, Math.max(0.0001, cdf));
    });
}

// ---------------------------------------------------------------------------
// 2. Autocorrelation function & Ljung-Box Q test
// ---------------------------------------------------------------------------
function autocorrelation(arr, maxLag = 10) {
    const n = arr.length;
    if (n < maxLag + 5) return [];
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    let denom = 0;
    for (let i = 0; i < n; i++) denom += (arr[i] - mean) ** 2;
    if (denom <= 1e-12) return new Array(maxLag).fill(0);

    const acf = [];
    for (let k = 1; k <= maxLag; k++) {
        let num = 0;
        for (let i = 0; i < n - k; i++) {
            num += (arr[i] - mean) * (arr[i + k] - mean);
        }
        acf.push(num / denom);
    }
    return acf;
}

// Chi-Square survival function (upper tail) via Wilson-Hilferty approximation
function chiSquarePValue(x, df) {
    if (x <= 0 || df <= 0) return 1.0;
    const z = (Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
    return 1 - normCdf(z);
}

function normCdf(z) {
    if (z < -8) return 0;
    if (z > 8) return 1;
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
}

function ljungBoxTest(arr, lags = [1, 2, 3, 5, 10]) {
    const n = arr.length;
    const maxLag = Math.max(...lags);
    const acf = autocorrelation(arr, maxLag);
    if (acf.length < maxLag) return { q: 0, df: maxLag, pValue: 1.0, significant: false };

    let q = 0;
    for (let k = 1; k <= maxLag; k++) {
        const rk = acf[k - 1];
        q += (rk * rk) / (n - k);
    }
    q *= n * (n + 2);
    const pValue = chiSquarePValue(q, maxLag);
    return {
        q: Number(q.toFixed(3)),
        df: maxLag,
        pValue: Number(pValue.toFixed(4)),
        significant: pValue < 0.05
    };
}

// ---------------------------------------------------------------------------
// 3. Markov State Transitions & Permutation Independence Test
// ---------------------------------------------------------------------------
function markovAnalysis(values, stateCount = 3, iters = 400) {
    const n = values.length;
    if (n < 30) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const thresholds = [];
    for (let s = 1; s < stateCount; s++) {
        thresholds.push(sorted[Math.floor((s * n) / stateCount)]);
    }

    const stateOf = (v) => {
        for (let s = 0; s < thresholds.length; s++) {
            if (v < thresholds[s]) return s;
        }
        return thresholds.length;
    };

    const states = values.map(stateOf);
    const computeChi2 = (seq) => {
        const N = Array.from({ length: stateCount }, () => new Array(stateCount).fill(0));
        const rowSums = new Array(stateCount).fill(0);
        const colSums = new Array(stateCount).fill(0);
        let total = 0;
        for (let t = 0; t < seq.length - 1; t++) {
            N[seq[t]][seq[t + 1]]++;
            rowSums[seq[t]]++;
            colSums[seq[t + 1]]++;
            total++;
        }
        let chi2 = 0;
        for (let i = 0; i < stateCount; i++) {
            for (let j = 0; j < stateCount; j++) {
                const expected = (rowSums[i] * colSums[j]) / (total || 1);
                if (expected > 0) {
                    const diff = N[i][j] - expected;
                    chi2 += (diff * diff) / expected;
                }
            }
        }
        return { chi2, N, rowSums, colSums, total };
    };

    const { chi2: observedChi2, N, rowSums } = computeChi2(states);
    const df = (stateCount - 1) * (stateCount - 1);
    const asymptoticP = chiSquarePValue(observedChi2, df);

    // Permutation test to account for time-series overlap dependencies
    const rng = makeRng(55);
    const shuffled = [...states];
    let exceedCount = 0;
    for (let it = 0; it < iters; it++) {
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const tmp = shuffled[i];
            shuffled[i] = shuffled[j];
            shuffled[j] = tmp;
        }
        const { chi2: nullChi2 } = computeChi2(shuffled);
        if (nullChi2 >= observedChi2) exceedCount++;
    }
    const permutationP = (exceedCount + 1) / (iters + 1);

    const matrix = N.map((row, i) =>
        row.map((cnt) => (rowSums[i] > 0 ? Number((cnt / rowSums[i]).toFixed(3)) : 0))
    );

    return {
        stateCount,
        thresholds: thresholds.map((t) => Number(t.toFixed(2))),
        counts: N,
        transitionMatrix: matrix,
        chi2: Number(observedChi2.toFixed(3)),
        df,
        asymptoticPValue: Number(asymptoticP.toFixed(4)),
        permutationPValue: Number(permutationP.toFixed(4)),
        pValue: Number(permutationP.toFixed(4)),
        independent: permutationP >= 0.05
    };
}

// ---------------------------------------------------------------------------
// 4. Shannon Mutual Information & Conditional Entropy
// ---------------------------------------------------------------------------
function mutualInformationAnalysis(values, stateCount = 3, iters = 400) {
    const n = values.length;
    if (n < 40) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const thresholds = [];
    for (let s = 1; s < stateCount; s++) {
        thresholds.push(sorted[Math.floor((s * n) / stateCount)]);
    }
    const stateOf = (v) => {
        for (let s = 0; s < thresholds.length; s++) {
            if (v < thresholds[s]) return s;
        }
        return thresholds.length;
    };

    const states = values.map(stateOf);
    const computeMI = (seq) => {
        const joint = Array.from({ length: stateCount }, () => new Array(stateCount).fill(0));
        const px = new Array(stateCount).fill(0);
        const py = new Array(stateCount).fill(0);
        const T = seq.length - 1;

        for (let t = 0; t < T; t++) {
            joint[seq[t]][seq[t + 1]]++;
            px[seq[t]]++;
            py[seq[t + 1]]++;
        }

        let mi = 0;
        let hX = 0;
        for (let i = 0; i < stateCount; i++) {
            if (px[i] > 0) {
                const p = px[i] / T;
                hX -= p * Math.log2(p);
            }
            for (let j = 0; j < stateCount; j++) {
                if (joint[i][j] > 0) {
                    const pxy = joint[i][j] / T;
                    const denom = (px[i] / T) * (py[j] / T);
                    if (denom > 0) mi += pxy * Math.log2(pxy / denom);
                }
            }
        }
        return { mi: Math.max(0, mi), hX };
    };

    const { mi: observedMI, hX } = computeMI(states);

    const rng = makeRng(101);
    let nullSum = 0;
    let exceedCount = 0;
    const shuffled = [...states];
    for (let it = 0; it < iters; it++) {
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const tmp = shuffled[i];
            shuffled[i] = shuffled[j];
            shuffled[j] = tmp;
        }
        const { mi: nullMI } = computeMI(shuffled);
        nullSum += nullMI;
        if (nullMI >= observedMI) exceedCount++;
    }

    const meanNullMI = nullSum / iters;
    const permutationPValue = (exceedCount + 1) / (iters + 1);

    return {
        entropyBits: Number(hX.toFixed(4)),
        mutualInfoBits: Number(observedMI.toFixed(4)),
        expectedNullMIBits: Number(meanNullMI.toFixed(4)),
        excessMIBits: Number(Math.max(0, observedMI - meanNullMI).toFixed(4)),
        nmi: Number((hX > 0 ? observedMI / hX : 0).toFixed(4)),
        permutationPValue: Number(permutationPValue.toFixed(4)),
        pValue: Number(permutationPValue.toFixed(4)),
        significant: permutationPValue < 0.05
    };
}

// ---------------------------------------------------------------------------
// 5. Wald-Wolfowitz Runs Test
// ---------------------------------------------------------------------------
function runsTest(values) {
    const n = values.length;
    if (n < 20) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];

    const bits = values.map((v) => (v >= median ? 1 : 0));
    const n1 = bits.filter((b) => b === 1).length;
    const n0 = n - n1;
    if (n1 === 0 || n0 === 0) return { runs: 1, pValue: 1.0, random: true };

    let runs = 1;
    for (let i = 1; i < n; i++) {
        if (bits[i] !== bits[i - 1]) runs++;
    }

    const expected = (2 * n1 * n0) / n + 1;
    const variance = (2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1));
    const stdDev = Math.sqrt(Math.max(1e-6, variance));
    const z = (runs - expected) / stdDev;
    const pValue = 2 * (1 - normCdf(Math.abs(z))); // two-tailed

    return {
        n,
        median: Number(median.toFixed(2)),
        observedRuns: runs,
        expectedRuns: Number(expected.toFixed(2)),
        zScore: Number(z.toFixed(3)),
        pValue: Number(pValue.toFixed(4)),
        random: pValue >= 0.05
    };
}

// ---------------------------------------------------------------------------
// 6. Benjamini-Hochberg False Discovery Rate (FDR) Multi-Testing Correction
// ---------------------------------------------------------------------------
function adjustBenjaminiHochberg(pValues) {
    const m = pValues.length;
    if (m === 0) return [];
    const indexed = pValues.map((p, idx) => ({ p: Math.min(1.0, Math.max(0.0, p)), idx }))
        .sort((a, b) => a.p - b.p);

    const adjusted = new Array(m);
    let minCum = 1.0;
    for (let i = m - 1; i >= 0; i--) {
        const rank = i + 1;
        const rawAdj = (indexed[i].p * m) / rank;
        minCum = Math.min(minCum, rawAdj);
        adjusted[indexed[i].idx] = Math.min(1.0, Number(minCum.toFixed(4)));
    }
    return adjusted;
}

// ---------------------------------------------------------------------------
// Main Laboratory Analysis Pipeline
// ---------------------------------------------------------------------------
function analyzeDependence(values, opts = {}) {
    if (!Array.isArray(values) || values.length < 50) {
        return {
            error: `need at least 50 rounds for dependence analysis (have ${values ? values.length : 0})`,
            n: values ? values.length : 0
        };
    }

    const n = values.length;
    const pitValues = pitTransform(values, 0.04);

    const pitAcf = autocorrelation(pitValues, 5);
    const pitLjungBox = ljungBoxTest(pitValues, [1, 2, 3, 5]);

    const rawAcf = autocorrelation(values, 5);
    const logAcf = autocorrelation(values.map((v) => Math.log(Math.max(1.0, v))), 5);
    const ind13Acf = autocorrelation(values.map((v) => (v >= 1.30 ? 1 : 0)), 5);
    const ind20Acf = autocorrelation(values.map((v) => (v >= 2.00 ? 1 : 0)), 5);

    const markov3 = markovAnalysis(values, 3);
    const markov5 = markovAnalysis(values, 5);
    const mi = mutualInformationAnalysis(values, 3, opts.miIters ?? 400);
    const runs = runsTest(values);

    // Multi-testing FDR correction across hypothesis tests
    const testNames = ['PIT Ljung-Box', 'Markov 3-State', 'Markov 5-State', 'Mutual Information', 'Runs Test'];
    const rawPVals = [
        pitLjungBox.pValue,
        markov3 ? markov3.pValue : 1.0,
        markov5 ? markov5.pValue : 1.0,
        mi ? mi.pValue : 1.0,
        runs ? runs.pValue : 1.0
    ];
    const adjustedPVals = adjustBenjaminiHochberg(rawPVals);

    const fdrTests = testNames.map((name, i) => ({
        name,
        rawP: rawPVals[i],
        adjustedP: adjustedPVals[i],
        significantFdr: adjustedPVals[i] < 0.05,
        nominalDiscovery: rawPVals[i] < 0.05
    }));

    const confirmedFdrFlags = fdrTests.filter((t) => t.significantFdr);
    const nominalFlags = fdrTests.filter((t) => t.nominalDiscovery && !t.significantFdr);

    let verdict = 'NO_DEPENDENCE_DETECTED';
    if (confirmedFdrFlags.length > 0) {
        verdict = 'STATISTICALLY_SIGNIFICANT_DEPENDENCE';
    }

    return {
        n,
        verdict,
        fdrTests,
        confirmedFdrFlags: confirmedFdrFlags.map((t) => `${t.name} (adj p=${t.adjustedP})`),
        nominalFlags: nominalFlags.map((t) => `${t.name} (raw p=${t.rawP}, adj p=${t.adjustedP})`),
        pit: {
            autocorrLags: [1, 2, 3, 4, 5],
            autocorr: pitAcf.map((v) => Number(v.toFixed(4))),
            ljungBox: pitLjungBox
        },
        autocorrelation: {
            raw: rawAcf.map((v) => Number(v.toFixed(4))),
            log: logAcf.map((v) => Number(v.toFixed(4))),
            indicator13: ind13Acf.map((v) => Number(v.toFixed(4))),
            indicator20: ind20Acf.map((v) => Number(v.toFixed(4)))
        },
        markov3,
        markov5,
        mutualInformation: mi,
        runsTest: runs,
        summary: verdict === 'NO_DEPENDENCE_DETECTED'
            ? `All 5 statistical tests confirm the series is consistent with an independent random process after Benjamini-Hochberg FDR correction (all adj p > 0.05).`
            : verdict === 'DISCOVERY_CANDIDATE_UNCONFIRMED'
                ? `Nominal discovery candidate (${nominalFlags.map((t) => t.name).join(', ')}) did not clear multiple-testing FDR correction. Requires out-of-sample confirmation.`
                : `Statistically significant dependence confirmed after FDR correction: ${confirmedFdrFlags.map((t) => t.name).join(', ')}.`
    };
}

module.exports = {
    pitTransform,
    autocorrelation,
    ljungBoxTest,
    markovAnalysis,
    mutualInformationAnalysis,
    runsTest,
    adjustBenjaminiHochberg,
    benjaminiHochberg: adjustBenjaminiHochberg,
    analyzeDependence,
    chiSquarePValue,
    normCdf
};
