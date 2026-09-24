'use strict';

/**
 * research/hypothesisEngine.js
 *
 * Automated Hypothesis Discovery, Multi-Fold OOS Walk Validation,
 * and Candidate Lifecycle Engine.
 *
 * Generates hundreds of explicit conditional hypotheses across sequences,
 * volatility states, streak lengths, and timing/distance metrics, filters them
 * with False Discovery Rate (FDR) multiple-testing correction, validates survivors
 * across expanding multi-fold out-of-sample partitions, and confirms on locked
 * holdouts using Holm-Bonferroni family-wise error rate control.
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { symbolOf } = require('../game/features');
const { normCdf, adjustBenjaminiHochberg } = require('./dependenceLab');

function makeRng(seed = 42) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
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
 * Holm-Bonferroni step-down family-wise error rate adjustment.
 *
 * @param {number[]} pValues
 * @returns {number[]} Adjusted p-values
 */
function adjustHolmBonferroni(pValues) {
    if (!Array.isArray(pValues) || pValues.length === 0) return [];
    const n = pValues.length;
    const indexed = pValues.map((p, i) => ({ p: Number.isFinite(p) ? p : 1.0, index: i }));
    indexed.sort((a, b) => a.p - b.p);

    const adj = new Array(n);
    let runningMax = 0;
    for (let k = 0; k < n; k++) {
        const factor = n - k;
        const rawAdj = indexed[k].p * factor;
        runningMax = Math.max(runningMax, rawAdj);
        adj[indexed[k].index] = Math.min(1.0, Math.max(0.0, runningMax));
    }
    return adj;
}

/**
 * Wilson score 95% lower bound for binomial proportion.
 */
function wilsonScoreLower(wins, n, z = 1.96) {
    if (n <= 0) return 0;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const rad = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (center - rad) / denom);
}

/**
 * Generates the extensive hypothesis search space (350+ hypotheses).
 * Each hypothesis is a predicate function (history, t) => boolean.
 */
function generateHypotheses(targets = [1.20, 1.30, 1.50, 1.80, 2.00, 3.00, 5.00]) {
    const list = [];

    for (const target of targets) {
        // --- Category 1: Single Prior State Triggers ---
        list.push({
            id: `prior_instant_crash_target_${target}`,
            name: `Previous crash was instant (< 1.10x) (Target ${target}x)`,
            category: 'single_prior',
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] < 1.10
        });

        list.push({
            id: `prior_low_crash_target_${target}`,
            name: `Previous crash was low (< 1.30x) (Target ${target}x)`,
            category: 'single_prior',
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] < 1.30
        });

        list.push({
            id: `prior_high_crash_target_${target}`,
            name: `Previous crash was high (>= 3.00x) (Target ${target}x)`,
            category: 'single_prior',
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] >= 3.00
        });

        list.push({
            id: `prior_super_crash_target_${target}`,
            name: `Previous crash was huge (>= 10.00x) (Target ${target}x)`,
            category: 'single_prior',
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] >= 10.00
        });

        // --- Category 2: Consecutive Streak Triggers ---
        for (let streak = 2; streak <= 6; streak++) {
            list.push({
                id: `cold_streak_${streak}_target_${target}`,
                name: `${streak} consecutive crashes < 1.50x (Target ${target}x)`,
                category: 'streak',
                target,
                predicate: (h, t) => {
                    if (t < streak) return false;
                    for (let i = 1; i <= streak; i++) {
                        if (h[t - i] >= 1.50) return false;
                    }
                    return true;
                }
            });

            list.push({
                id: `warm_streak_${streak}_target_${target}`,
                name: `${streak} consecutive crashes >= 2.00x (Target ${target}x)`,
                category: 'streak',
                target,
                predicate: (h, t) => {
                    if (t < streak) return false;
                    for (let i = 1; i <= streak; i++) {
                        if (h[t - i] < 2.00) return false;
                    }
                    return true;
                }
            });
        }

        // --- Category 3: Rolling Window Density Triggers ---
        for (const winSize of [5, 10, 20]) {
            list.push({
                id: `cold_density_${winSize}_target_${target}`,
                name: `>= 70% cold crashes in last ${winSize} rounds (Target ${target}x)`,
                category: 'density',
                target,
                predicate: (h, t) => {
                    if (t < winSize) return false;
                    let cold = 0;
                    for (let i = 1; i <= winSize; i++) {
                        if (h[t - i] < 1.50) cold++;
                    }
                    return (cold / winSize) >= 0.70;
                }
            });

            list.push({
                id: `hot_density_${winSize}_target_${target}`,
                name: `>= 50% high crashes in last ${winSize} rounds (Target ${target}x)`,
                category: 'density',
                target,
                predicate: (h, t) => {
                    if (t < winSize) return false;
                    let hot = 0;
                    for (let i = 1; i <= winSize; i++) {
                        if (h[t - i] >= 2.00) hot++;
                    }
                    return (hot / winSize) >= 0.50;
                }
            });
        }

        // --- Category 4: Volatility and Range Triggers ---
        list.push({
            id: `low_volatility_5_target_${target}`,
            name: `Tight variance over last 5 rounds (Target ${target}x)`,
            category: 'volatility',
            target,
            predicate: (h, t) => {
                if (t < 5) return false;
                const slice = h.slice(t - 5, t);
                const mean = slice.reduce((a, b) => a + b, 0) / 5;
                const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 5;
                return variance < 0.20;
            }
        });

        list.push({
            id: `high_volatility_5_target_${target}`,
            name: `High variance over last 5 rounds (Target ${target}x)`,
            category: 'volatility',
            target,
            predicate: (h, t) => {
                if (t < 5) return false;
                const slice = h.slice(t - 5, t);
                const mean = slice.reduce((a, b) => a + b, 0) / 5;
                const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 5;
                return variance > 5.0;
            }
        });

        // --- Category 5: Distance Since Extreme Event ---
        for (const dist of [10, 20, 30]) {
            list.push({
                id: `distance_since_10x_${dist}_target_${target}`,
                name: `No 10x+ crash in last ${dist} rounds (Target ${target}x)`,
                category: 'distance',
                target,
                predicate: (h, t) => {
                    if (t < dist) return false;
                    for (let i = 1; i <= dist; i++) {
                        if (h[t - i] >= 10.0) return false;
                    }
                    return true;
                }
            });
        }

        // --- Category 6: 2-Round Sequence Patterns (LL, LM, LH, ML, MM, MH, HL, HM, HH) ---
        const syms = ['L', 'M', 'H'];
        for (const s1 of syms) {
            for (const s2 of syms) {
                const pat = `${s1}${s2}`;
                list.push({
                    id: `pattern_${pat}_target_${target}`,
                    name: `2-Round Pattern "${pat}" (Target ${target}x)`,
                    category: 'sequence',
                    target,
                    predicate: (h, t) => {
                        if (t < 2) return false;
                        return symbolOf(h[t - 2]) === s1 && symbolOf(h[t - 1]) === s2;
                    }
                });
            }
        }

        // --- Category 7: 3-Round Sequence Patterns (LLL, LLM, LLH, ..., HHH = 27) ---
        for (const s1 of syms) {
            for (const s2 of syms) {
                for (const s3 of syms) {
                    const pat = `${s1}${s2}${s3}`;
                    list.push({
                        id: `pattern_${pat}_target_${target}`,
                        name: `3-Round Pattern "${pat}" (Target ${target}x)`,
                        category: 'sequence',
                        target,
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

        const baseRate = nTotal > 0 ? totalBaseWins / nTotal : (0.97 / target);
        const hitRate = nMatches > 0 ? nWins / nMatches : 0;
        const lift = hitRate - baseRate;
        const breakEven = 1 / target;
        const evPerBet = nMatches > 0 ? hitRate * target - 1 : null;
        const wilsonLower = wilsonScoreLower(nWins, nMatches);

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
            wilsonLower: Number(wilsonLower.toFixed(4)),
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
 * Tier 3 (25% Locked Holdout) -> Holm-Bonferroni FWER Multiple-Testing Filter
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

    const minDiscN = opts.minDiscoveryN || 12;
    const tier1Candidates = [];
    for (let i = 0; i < tier1Results.length; i++) {
        const r = tier1Results[i];
        r.adjPVal = adjPVals[i];
        // Discovery criteria: minimum occurrences, positive lift, and FDR-adjusted p < 0.10
        if (r.n >= minDiscN && r.lift > 0.02 && r.adjPVal < 0.10) {
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
    const minOosN = opts.minOosN || 6;

    for (const cand of tier1Candidates) {
        const oosCombined = evaluatePartition([cand.hypDef], history, split1, split2)[0];
        const fold1 = evaluatePartition([cand.hypDef], history, split1, oosMid)[0];
        const fold2 = evaluatePartition([cand.hypDef], history, oosMid, split2)[0];

        const passedOos = oosCombined && oosCombined.n >= minOosN && oosCombined.lift > 0.01 && oosCombined.evPerBet > 0 && oosCombined.pVal < 0.10;
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
    // TIER 3: Locked Final Holdout Confirmation (Holm-Bonferroni FWER Control)
    // -----------------------------------------------------------------------
    const tier3RawResults = [];
    for (const cand of tier2Surviving) {
        const holdoutRes = evaluatePartition([cand.hypDef], history, split2, n)[0];
        tier3RawResults.push({ cand, holdoutRes });
    }

    // Multiple-testing correction across all candidates tested against locked holdout
    const tier3PVals = tier3RawResults.map((r) => (r.holdoutRes ? r.holdoutRes.pVal : 1.0));
    const tier3AdjPVals = adjustHolmBonferroni(tier3PVals);

    const minHoldoutN = opts.minHoldoutN || 6;
    const finalCandidates = [];

    for (let i = 0; i < tier3RawResults.length; i++) {
        const { cand, holdoutRes } = tier3RawResults[i];
        const adjP = tier3AdjPVals[i];
        const confirmed = holdoutRes &&
                          holdoutRes.n >= minHoldoutN &&
                          holdoutRes.lift > 0.01 &&
                          holdoutRes.evPerBet > 0 &&
                          adjP < (opts.holdoutAlpha || 0.05);

        finalCandidates.push({
            id: cand.id,
            name: cand.name,
            target: cand.target,
            category: cand.category,
            status: confirmed ? 'HOLDOUT_CONFIRMED' : 'REJECTED_ON_HOLDOUT',
            discovery: cand.discovery,
            oos: cand.oos,
            fold1: cand.fold1,
            fold2: cand.fold2,
            holdout: holdoutRes ? {
                ...holdoutRes,
                adjPVal: Number(adjP.toFixed(4))
            } : null,
            confirmedAt: confirmed ? Date.now() : null
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
            status: c.status,
            oos: c.oos
        })),
        finalRegistry: finalCandidates,
        summary: confirmedList.length > 0
            ? `${confirmedList.length} hypothesis candidate(s) survived strict 3-tier discovery, multi-fold OOS validation, and Holm-corrected locked holdout!`
            : `Tested ${allHypotheses.length} conditional hypotheses across sequences, volatility, and timing. None survived the strict 3-tier OOS + Holm holdout gauntlet.`
    };
}

module.exports = {
    exactBinomialPValue,
    adjustHolmBonferroni,
    wilsonScoreLower,
    generateHypotheses,
    generateAllHypotheses: generateHypotheses,
    evaluatePartition,
    runHypothesisEngine
};
