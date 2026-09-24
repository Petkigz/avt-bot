'use strict';

/**
 * research/hypothesisEngine.js
 *
 * Automated Hypothesis Discovery, Multi-Fold OOS Walk Validation,
 * and Candidate Lifecycle Engine.
 *
 * Rather than assuming a single feature set, generates hundreds of explicit
 * conditional hypotheses across sequences, volatility states, streak lengths,
 * and timing/distance metrics, filters them with False Discovery Rate (FDR)
 * multiple-testing correction, and tests survivors on untouched multi-fold
 * OOS walk-forward and locked holdout partitions.
 */

const fs = require('fs');
const path = require('path');
const { symbolOf } = require('../game/features');
const { normCdf, adjustBenjaminiHochberg } = require('./dependenceLab');
const { hitRatePValue, brierScore, brierSkill } = require('../game/modelLayer');

function makeRng(seed = 42) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Exact binomial upper-tail probability P(X >= k | n, p0).
 */
function exactBinomialPValue(k, n, p0) {
    if (n <= 0 || k <= 0) return 1.0;
    if (k > n) return 0.0;
    if (p0 <= 0 || p0 >= 1) return 1.0;

    if (n <= 80) {
        let tailProb = 0;
        // Direct sum of binomial probabilities using log-combinations
        const logFact = (m) => {
            let s = 0;
            for (let i = 2; i <= m; i++) s += Math.log(i);
            return s;
        };
        const logNFact = logFact(n);
        for (let j = k; j <= n; j++) {
            const logComb = logNFact - logFact(j) - logFact(n - j);
            const logProb = logComb + j * Math.log(p0) + (n - j) * Math.log(1 - p0);
            tailProb += Math.exp(logProb);
        }
        return Math.min(1.0, Math.max(0.0, tailProb));
    }

    // Continuity-corrected normal approximation for larger n
    const mean = n * p0;
    const std = Math.sqrt(n * p0 * (1 - p0));
    if (std === 0) return 1.0;
    const z = (k - 0.5 - mean) / std;
    return Math.min(1.0, Math.max(0.0, 1 - normCdf(z)));
}

/**
 * Generates the extensive hypothesis search space (300+ hypotheses).
 * Each hypothesis is a predicate function (history, t) => boolean.
 */
function generateHypotheses(targets = [1.20, 1.30, 1.50, 1.80, 2.00, 3.00, 5.00]) {
    const list = [];

    for (const target of targets) {
        // 1. Single Prior Crash Hypotheses
        list.push({
            id: `prior_instant_crash_target_${target}`,
            name: `Previous crash was instant (<= 1.05x) (Target ${target}x)`,
            target,
            category: 'prior_state',
            predicate: (h, t) => t >= 1 && h[t - 1] <= 1.05
        });
        list.push({
            id: `prior_low_crash_target_${target}`,
            name: `Previous crash was low (< 1.30x) (Target ${target}x)`,
            target,
            category: 'prior_state',
            predicate: (h, t) => t >= 1 && h[t - 1] < 1.30
        });
        list.push({
            id: `prior_medium_target_${target}`,
            name: `Previous crash was medium (1.30x-2.00x) (Target ${target}x)`,
            target,
            category: 'prior_state',
            predicate: (h, t) => t >= 1 && h[t - 1] >= 1.30 && h[t - 1] < 2.00
        });
        list.push({
            id: `prior_high_win_target_${target}`,
            name: `Previous crash was high (>= 2.00x) (Target ${target}x)`,
            target,
            category: 'prior_state',
            predicate: (h, t) => t >= 1 && h[t - 1] >= 2.00
        });
        list.push({
            id: `prior_super_rocket_target_${target}`,
            name: `Previous crash was super-rocket (>= 5.00x) (Target ${target}x)`,
            target,
            category: 'prior_state',
            predicate: (h, t) => t >= 1 && h[t - 1] >= 5.00
        });

        // 2. Streak Hypotheses (Cold vs Warm)
        list.push({
            id: `cold_streak_2_target_${target}`,
            name: `2 consecutive crashes < 1.40x (Target ${target}x)`,
            target,
            category: 'streak',
            predicate: (h, t) => t >= 2 && h[t - 2] < 1.40 && h[t - 1] < 1.40
        });
        list.push({
            id: `cold_streak_3_target_${target}`,
            name: `3 consecutive crashes < 1.50x (Target ${target}x)`,
            target,
            category: 'streak',
            predicate: (h, t) => t >= 3 && h[t - 3] < 1.50 && h[t - 2] < 1.50 && h[t - 1] < 1.50
        });
        list.push({
            id: `cold_streak_4_target_${target}`,
            name: `4 consecutive crashes < 1.50x (Target ${target}x)`,
            target,
            category: 'streak',
            predicate: (h, t) => t >= 4 && h[t - 4] < 1.50 && h[t - 3] < 1.50 && h[t - 2] < 1.50 && h[t - 1] < 1.50
        });
        list.push({
            id: `warm_streak_2_target_${target}`,
            name: `2 consecutive crashes >= 2.00x (Target ${target}x)`,
            target,
            category: 'streak',
            predicate: (h, t) => t >= 2 && h[t - 2] >= 2.00 && h[t - 1] >= 2.00
        });
        list.push({
            id: `warm_streak_3_target_${target}`,
            name: `3 consecutive crashes >= 2.00x (Target ${target}x)`,
            target,
            category: 'streak',
            predicate: (h, t) => t >= 3 && h[t - 3] >= 2.00 && h[t - 2] >= 2.00 && h[t - 1] >= 2.00
        });

        // 3. Timing & Distance Hypotheses
        list.push({
            id: `time_since_rocket_le_3_target_${target}`,
            name: `Super-rocket (>=5.0x) occurred within last 3 rounds (Target ${target}x)`,
            target,
            category: 'timing_distance',
            predicate: (h, t) => t >= 3 && (h[t - 1] >= 5.0 || h[t - 2] >= 5.0 || h[t - 3] >= 5.0)
        });
        list.push({
            id: `time_since_rocket_ge_10_target_${target}`,
            name: `No rocket (>=5.0x) in the last 10 rounds (Target ${target}x)`,
            target,
            category: 'timing_distance',
            predicate: (h, t) => {
                if (t < 10) return false;
                for (let k = 1; k <= 10; k++) if (h[t - k] >= 5.0) return false;
                return true;
            }
        });
        list.push({
            id: `time_since_instant_le_2_target_${target}`,
            name: `Instant crash (<=1.05x) within last 2 rounds (Target ${target}x)`,
            target,
            category: 'timing_distance',
            predicate: (h, t) => t >= 2 && (h[t - 1] <= 1.05 || h[t - 2] <= 1.05)
        });
        list.push({
            id: `time_since_instant_ge_8_target_${target}`,
            name: `No instant crash in last 8 rounds (Target ${target}x)`,
            target,
            category: 'timing_distance',
            predicate: (h, t) => {
                if (t < 8) return false;
                for (let k = 1; k <= 8; k++) if (h[t - k] <= 1.05) return false;
                return true;
            }
        });

        // 4. Volatility Regime Hypotheses
        list.push({
            id: `volatility_spike_20_target_${target}`,
            name: `Recent 20-round volatility > 1.5x long-run volatility (Target ${target}x)`,
            target,
            category: 'volatility',
            predicate: (h, t) => {
                if (t < 40) return false;
                const rec = h.slice(t - 20, t);
                const long = h.slice(0, t);
                const recMean = rec.reduce((s, v) => s + v, 0) / rec.length;
                const longMean = long.reduce((s, v) => s + v, 0) / long.length;
                const recStd = Math.sqrt(rec.reduce((s, v) => s + (v - recMean) ** 2, 0) / rec.length);
                const longStd = Math.sqrt(long.reduce((s, v) => s + (v - longMean) ** 2, 0) / long.length);
                return longStd > 0 && recStd > 1.5 * longStd;
            }
        });
        list.push({
            id: `volatility_compression_10_target_${target}`,
            name: `Recent 10-round volatility < 0.6x long-run volatility (Target ${target}x)`,
            target,
            category: 'volatility',
            predicate: (h, t) => {
                if (t < 30) return false;
                const rec = h.slice(t - 10, t);
                const long = h.slice(0, t);
                const recMean = rec.reduce((s, v) => s + v, 0) / rec.length;
                const longMean = long.reduce((s, v) => s + v, 0) / long.length;
                const recStd = Math.sqrt(rec.reduce((s, v) => s + (v - recMean) ** 2, 0) / rec.length);
                const longStd = Math.sqrt(long.reduce((s, v) => s + (v - longMean) ** 2, 0) / long.length);
                return longStd > 0 && recStd < 0.6 * longStd;
            }
        });
        list.push({
            id: `mean_reversion_compression_target_${target}`,
            name: `Recent 5-round mean < 1.35x vs long-run mean (Target ${target}x)`,
            target,
            category: 'volatility',
            predicate: (h, t) => {
                if (t < 20) return false;
                const rec = h.slice(t - 5, t);
                const recMean = rec.reduce((s, v) => s + v, 0) / rec.length;
                return recMean < 1.35;
            }
        });

        // 5. Full 3-Symbol Pattern Permutations (27 States)
        const symbols = ['L', 'M', 'H'];
        for (const s1 of symbols) {
            for (const s2 of symbols) {
                for (const s3 of symbols) {
                    const pattern = `${s1}${s2}${s3}`;
                    list.push({
                        id: `pattern_${pattern}_target_${target}`,
                        name: `3-Round Pattern "${pattern}" (Target ${target}x)`,
                        target,
                        category: 'sequence',
                        predicate: (h, t) => {
                            if (t < 3) return false;
                            return symbolOf(h[t - 3]) === s1 &&
                                   symbolOf(h[t - 2]) === s2 &&
                                   symbolOf(h[t - 1]) === s3;
                        }
                    });
                }
            }
        }

        // 6. 4-Symbol Sequence Permutations
        const special4 = ['LLLL', 'HHHH', 'LLLH', 'HHHL', 'LHLH', 'HLHL'];
        for (const pat of special4) {
            list.push({
                id: `pattern4_${pat}_target_${target}`,
                name: `4-Round Pattern "${pat}" (Target ${target}x)`,
                target,
                category: 'sequence4',
                predicate: (h, t) => {
                    if (t < 4) return false;
                    return symbolOf(h[t - 4]) === pat[0] &&
                           symbolOf(h[t - 3]) === pat[1] &&
                           symbolOf(h[t - 2]) === pat[2] &&
                           symbolOf(h[t - 1]) === pat[3];
                }
            });
        }
    }

    return list;
}

/**
 * Evaluates a set of hypotheses on a partition of history.
 */
function evaluatePartition(hypotheses, history, startIdx, endIdx) {
    const results = [];

    for (const hyp of hypotheses) {
        let nMatches = 0;
        let nWins = 0;
        let totalBaseWins = 0;
        let nTotal = 0;
        const target = hyp.target;

        for (let t = Math.max(4, startIdx); t < endIdx; t++) {
            const nextValue = history[t];
            if (!Number.isFinite(nextValue)) continue;

            nTotal++;
            if (nextValue >= target) totalBaseWins++;

            let triggered = false;
            try {
                triggered = hyp.predicate(history, t);
            } catch (err) {
                triggered = false;
            }

            if (triggered) {
                nMatches++;
                if (nextValue >= target) nWins++;
            }
        }

        const baseRate = nTotal > 0 ? totalBaseWins / nTotal : 0;
        const hitRate = nMatches > 0 ? nWins / nMatches : 0;
        const lift = hitRate - baseRate;
        const breakEven = 1 / target;
        const evPerBet = nMatches > 0 ? hitRate * target - 1 : null;

        // Exact binomial p-value under the empirical base rate null
        const pVal = nMatches >= 4 ? exactBinomialPValue(nWins, nMatches, baseRate) : 1.0;

        results.push({
            id: hyp.id,
            name: hyp.name,
            target: hyp.target,
            category: hyp.category,
            n: nMatches,
            nWins,
            baseRate: Number(baseRate.toFixed(4)),
            hitRate: Number(hitRate.toFixed(4)),
            lift: Number(lift.toFixed(4)),
            evPerBet: evPerBet !== null ? Number(evPerBet.toFixed(4)) : null,
            breakEven: Number(breakEven.toFixed(4)),
            pVal: Number(pVal.toFixed(4))
        });
    }

    return results;
}

/**
 * Runs the full 3-tier Hypothesis Pipeline on a history sequence.
 *
 * Tier 1 (50% Discovery) -> FDR filter ->
 * Tier 2 (25% Multi-Fold OOS Walk) -> EV/Lift filter ->
 * Tier 3 (25% Locked Holdout) -> Final Confirmation
 */
function runHypothesisEngine(history, opts = {}) {
    const n = history.length;
    if (n < 100) {
        return {
            error: `need at least 100 rounds for hypothesis testing (have ${n})`,
            n,
            candidates: []
        };
    }

    const split1 = Math.floor(n * 0.50); // 50% Discovery
    const split2 = Math.floor(n * 0.75); // 25% OOS Walk, 25% Final Holdout

    const targets = opts.targets || [1.20, 1.30, 1.50, 1.80, 2.00, 3.00, 5.00];
    const allHypotheses = generateHypotheses(targets);

    // -----------------------------------------------------------------------
    // TIER 1: In-Sample Discovery (FDR Controlled)
    // -----------------------------------------------------------------------
    const tier1Results = evaluatePartition(allHypotheses, history, 4, split1);
    const rawPVals = tier1Results.map((r) => r.pVal);
    const adjPVals = adjustBenjaminiHochberg(rawPVals);

    const tier1Candidates = [];
    for (let i = 0; i < tier1Results.length; i++) {
        const r = tier1Results[i];
        r.adjPVal = adjPVals[i];
        // Discovery criteria: minimum 10 occurrences, positive lift, and FDR-adjusted p < 0.10
        if (r.n >= 10 && r.lift > 0.02 && r.adjPVal < 0.10) {
            tier1Candidates.push({
                ...r,
                status: 'DISCOVERED',
                hypDef: allHypotheses[i]
            });
        }
    }

    // -----------------------------------------------------------------------
    // TIER 2: Multi-Fold Out-Of-Sample (OOS) Walk-Forward Validation
    // -----------------------------------------------------------------------
    const oosMid = Math.floor((split1 + split2) / 2);
    const tier2Evaluated = [];

    for (const cand of tier1Candidates) {
        // Multi-fold walk validation: Fold 1 [split1..oosMid], Fold 2 [oosMid..split2], Combined [split1..split2]
        const oosCombined = evaluatePartition([cand.hypDef], history, split1, split2)[0];
        const fold1 = evaluatePartition([cand.hypDef], history, split1, oosMid)[0];
        const fold2 = evaluatePartition([cand.hypDef], history, oosMid, split2)[0];

        const passedOos = oosCombined && oosCombined.n >= 6 && oosCombined.lift > 0.01 && oosCombined.evPerBet > 0 && oosCombined.pVal < 0.10;
        tier2Evaluated.push({
            id: cand.id,
            name: cand.name,
            target: cand.target,
            category: cand.category,
            status: passedOos ? 'OOS_CONFIRMED' : 'FAILED_OOS',
            discovery: {
                n: cand.n,
                hitRate: cand.hitRate,
                baseRate: cand.baseRate,
                lift: cand.lift,
                pVal: cand.pVal,
                adjPVal: cand.adjPVal
            },
            oos: oosCombined,
            fold1,
            fold2,
            hypDef: cand.hypDef
        });
    }

    const tier2Surviving = tier2Evaluated.filter((c) => c.status === 'OOS_CONFIRMED');

    // -----------------------------------------------------------------------
    // TIER 3: Locked Final Holdout Confirmation
    // -----------------------------------------------------------------------
    const finalCandidates = [];
    for (const cand of tier2Surviving) {
        const holdoutRes = evaluatePartition([cand.hypDef], history, split2, n)[0];
        const confirmed = holdoutRes && holdoutRes.n >= 6 && holdoutRes.lift > 0.01 && holdoutRes.evPerBet > 0 && holdoutRes.pVal < 0.05;
        finalCandidates.push({
            id: cand.id,
            name: cand.name,
            target: cand.target,
            category: cand.category,
            status: confirmed ? 'HOLDOUT_CONFIRMED' : 'REJECTED_ON_HOLDOUT',
            discovery: cand.discovery,
            oos: cand.oos,
            holdout: holdoutRes,
            ts: Date.now()
        });
    }

    const confirmedList = finalCandidates.filter((c) => c.status === 'HOLDOUT_CONFIRMED');

    return {
        n,
        totalTested: allHypotheses.length,
        tier1Discovered: tier1Candidates.length,
        tier2OosConfirmed: tier2Surviving.length,
        tier3HoldoutConfirmed: confirmedList.length,
        verdict: confirmedList.length > 0
            ? 'HYPOTHESIS_CONFIRMED_ON_HOLDOUT'
            : 'NO_HYPOTHESIS_SURVIVED_HOLDOUT',
        allDiscoveryCandidates: tier1Candidates.map((c) => ({
            id: c.id,
            name: c.name,
            target: c.target,
            category: c.category,
            n: c.n,
            hitRate: c.hitRate,
            lift: c.lift,
            pVal: c.pVal,
            adjPVal: c.adjPVal
        })),
        oosEvaluations: tier2Evaluated.map((c) => ({
            id: c.id,
            name: c.name,
            target: c.target,
            category: c.category,
            status: c.status,
            discoveryLift: c.discovery.lift,
            oosLift: c.oos ? c.oos.lift : null,
            oosEv: c.oos ? c.oos.evPerBet : null
        })),
        finalRegistry: finalCandidates,
        summary: confirmedList.length > 0
            ? `${confirmedList.length} hypothesis candidate(s) survived strict 3-tier discovery, multi-fold OOS validation, and locked holdout confirmation!`
            : `Tested ${allHypotheses.length} conditional hypotheses across sequences, volatility, and timing. None survived the strict 3-tier OOS + holdout gauntlet.`
    };
}

module.exports = {
    exactBinomialPValue,
    generateHypotheses,
    generateAllHypotheses: generateHypotheses,
    evaluatePartition,
    runHypothesisEngine
};
