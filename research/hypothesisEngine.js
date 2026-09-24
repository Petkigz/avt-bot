'use strict';

/**
 * research/hypothesisEngine.js
 *
 * Automated Hypothesis Discovery, Out-Of-Sample (OOS) Validation,
 * and Candidate Lifecycle Engine.
 *
 * Rather than assuming a single feature set, generates hundreds of explicit
 * conditional hypotheses across sequences, volatility states, and timing,
 * filters them with False Discovery Rate (FDR) multiple-testing correction,
 * and tests survivors on untouched OOS walk-forward and holdout partitions.
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
 * Generates the hypothesis search space.
 * Each hypothesis is a predicate function (history, t) => boolean
 */
function generateHypotheses(targets = [1.30, 1.50, 2.00]) {
    const list = [];

    for (const target of targets) {
        // 1. Single prior state hypotheses
        list.push({
            id: `prior_low_crash_target_${target}`,
            name: `Previous crash was < 1.30x (Target ${target}x)`,
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] < 1.30
        });
        list.push({
            id: `prior_high_win_target_${target}`,
            name: `Previous crash was >= 2.00x (Target ${target}x)`,
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] >= 2.00
        });
        list.push({
            id: `prior_instant_crash_target_${target}`,
            name: `Previous crash was instant (<= 1.05x) (Target ${target}x)`,
            target,
            predicate: (h, t) => t >= 1 && h[t - 1] <= 1.05
        });

        // 2. Streak hypotheses
        list.push({
            id: `cold_streak_2_target_${target}`,
            name: `2 consecutive crashes < 1.40x (Target ${target}x)`,
            target,
            predicate: (h, t) => t >= 2 && h[t - 2] < 1.40 && h[t - 1] < 1.40
        });
        list.push({
            id: `cold_streak_3_target_${target}`,
            name: `3 consecutive crashes < 1.50x (Target ${target}x)`,
            target,
            predicate: (h, t) => t >= 3 && h[t - 3] < 1.50 && h[t - 2] < 1.50 && h[t - 1] < 1.50
        });
        list.push({
            id: `warm_streak_2_target_${target}`,
            name: `2 consecutive crashes >= 2.00x (Target ${target}x)`,
            target,
            predicate: (h, t) => t >= 2 && h[t - 2] >= 2.00 && h[t - 1] >= 2.00
        });

        // 3. Volatility regime hypotheses
        list.push({
            id: `volatility_spike_target_${target}`,
            name: `Recent 20-round volatility > 1.5x long-run volatility (Target ${target}x)`,
            target,
            predicate: (h, t) => {
                if (t < 40) return false;
                const rec = h.slice(Math.max(0, t - 20), t);
                const long = h.slice(0, t);
                const recMean = rec.reduce((s, v) => s + v, 0) / rec.length;
                const longMean = long.reduce((s, v) => s + v, 0) / long.length;
                const recStd = Math.sqrt(rec.reduce((s, v) => s + (v - recMean) ** 2, 0) / rec.length);
                const longStd = Math.sqrt(long.reduce((s, v) => s + (v - longMean) ** 2, 0) / long.length);
                return longStd > 0 && recStd > 1.5 * longStd;
            }
        });

        // 4. Full 3-symbol pattern permutations (27 states)
        const symbols = ['L', 'M', 'H'];
        for (const s1 of symbols) {
            for (const s2 of symbols) {
                for (const s3 of symbols) {
                    const pattern = `${s1}${s2}${s3}`;
                    list.push({
                        id: `pattern_${pattern}_target_${target}`,
                        name: `3-Round Pattern "${pattern}" (Target ${target}x)`,
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
    const nTotal = endIdx - startIdx;
    if (nTotal < 10) return results;

    for (const hyp of hypotheses) {
        let nMatches = 0;
        let nWins = 0;
        let totalBaseWins = 0;
        const target = hyp.target;

        for (let t = startIdx; t < endIdx; t++) {
            const won = history[t] >= target ? 1 : 0;
            if (won) totalBaseWins++;
            if (hyp.predicate(history, t)) {
                nMatches++;
                if (won) nWins++;
            }
        }

        const baseRate = nTotal > 0 ? totalBaseWins / nTotal : 0;
        const hitRate = nMatches > 0 ? nWins / nMatches : 0;
        const lift = hitRate - baseRate;
        const breakEven = 1 / target;
        const evPerBet = nMatches > 0 ? hitRate * target - 1 : null;

        // One-tailed binomial p-value under the base rate null
        const pVal = nMatches >= 5 ? hitRatePValue(nWins, nMatches, baseRate) : 1.0;

        results.push({
            id: hyp.id,
            name: hyp.name,
            target: hyp.target,
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
 * Tier 2 (25% OOS Walk) -> EV/Lift filter ->
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

    const allHypotheses = generateHypotheses(opts.targets || [1.30, 1.50, 2.00]);

    // -----------------------------------------------------------------------
    // TIER 1: In-Sample Discovery
    // -----------------------------------------------------------------------
    const tier1Results = evaluatePartition(allHypotheses, history, 3, split1);
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
    // TIER 2: Out-Of-Sample (OOS) Walk-Forward Validation
    // -----------------------------------------------------------------------
    const tier2Evaluated = [];
    for (const cand of tier1Candidates) {
        const oosRes = evaluatePartition([cand.hypDef], history, split1, split2)[0];
        const passedOos = oosRes && oosRes.n >= 6 && oosRes.lift > 0.01 && oosRes.evPerBet > 0 && oosRes.pVal < 0.10;
        tier2Evaluated.push({
            id: cand.id,
            name: cand.name,
            target: cand.target,
            status: passedOos ? 'OOS_CONFIRMED' : 'FAILED_OOS',
            discovery: {
                n: cand.n,
                hitRate: cand.hitRate,
                baseRate: cand.baseRate,
                lift: cand.lift,
                pVal: cand.pVal,
                adjPVal: cand.adjPVal
            },
            oos: oosRes,
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
            discoveryLift: c.discovery.lift,
            oosLift: c.oos ? c.oos.lift : null,
            oosEv: c.oos ? c.oos.evPerBet : null
        })),
        finalRegistry: finalCandidates,
        summary: confirmedList.length > 0
            ? `${confirmedList.length} hypothesis candidate(s) survived strict 3-tier discovery, OOS validation, and locked holdout confirmation!`
            : `Tested ${allHypotheses.length} conditional hypotheses across sequences, volatility, and timing. None survived the strict 3-tier OOS + holdout gauntlet.`
    };
}

module.exports = {
    generateHypotheses,
    generateAllHypotheses: generateHypotheses,
    evaluatePartition,
    runHypothesisEngine
};
