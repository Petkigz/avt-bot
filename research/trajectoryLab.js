'use strict';

/**
 * research/trajectoryLab.js
 *
 * Microstructure & In-Flight Trajectory Analysis Laboratory.
 *
 * Investigates whether early in-flight flight dynamics (slope over first 200-300ms,
 * acceleration, curvature, milestone transitions) or inter-round intervals contain
 * genuine predictive information about final crash outcomes BEFORE the flight terminates.
 *
 * Distinct Architecture:
 * - Pre-Round Models: History + State -> P(next crash >= T)
 * - In-Flight Models: Trajectory samples up to t0 -> P(flight reaches T | trajectory(0..t0))
 */

/**
 * Extracts causal pre-outcome features from an in-flight trajectory sample trace.
 * Crucial: Only consumes samples up to cutoffMs (e.g. 250ms) so features never leak the final outcome.
 */
function extractEarlyFlightFeatures(samples, cutoffMs = 300) {
    if (!Array.isArray(samples) || samples.length < 2) {
        return {
            earlySlope: null,
            earlyAcceleration: null,
            earlyCurvature: null,
            sampleCountEarly: 0
        };
    }

    const early = samples.filter((s) => Number.isFinite(s.t) && s.t <= cutoffMs && Number.isFinite(s.v));
    if (early.length < 2) {
        return {
            earlySlope: null,
            earlyAcceleration: null,
            earlyCurvature: null,
            sampleCountEarly: early.length
        };
    }

    const first = early[0];
    const last = early[early.length - 1];
    const dtSec = Math.max(0.01, (last.t - first.t) / 1000);
    const earlySlope = (last.v - first.v) / dtSec; // multiplier units per second

    // Acceleration: split early window into 2 halves
    let earlyAcceleration = null;
    if (early.length >= 3) {
        const midIdx = Math.floor(early.length / 2);
        const mid = early[midIdx];
        const dt1 = Math.max(0.005, (mid.t - first.t) / 1000);
        const dt2 = Math.max(0.005, (last.t - mid.t) / 1000);
        const s1 = (mid.v - first.v) / dt1;
        const s2 = (last.v - mid.v) / dt2;
        earlyAcceleration = (s2 - s1) / Math.max(0.01, (last.t - first.t) / 1000);
    }

    // Curvature: variance of incremental slopes
    let earlyCurvature = 0;
    if (early.length >= 4) {
        const segSlopes = [];
        for (let i = 1; i < early.length; i++) {
            const dt = Math.max(0.001, (early[i].t - early[i - 1].t) / 1000);
            segSlopes.push((early[i].v - early[i - 1].v) / dt);
        }
        const meanSlope = segSlopes.reduce((a, b) => a + b, 0) / segSlopes.length;
        const variance = segSlopes.reduce((s, v) => s + (v - meanSlope) ** 2, 0) / segSlopes.length;
        earlyCurvature = Math.sqrt(variance);
    }

    return {
        earlySlope: Number(earlySlope.toFixed(4)),
        earlyAcceleration: earlyAcceleration !== null ? Number(earlyAcceleration.toFixed(4)) : null,
        earlyCurvature: Number(earlyCurvature.toFixed(4)),
        sampleCountEarly: early.length
    };
}

/**
 * Evaluates whether early flight metrics correlate with surviving to target multipliers.
 */
function analyzeTrajectories(traces, opts = {}) {
    if (!Array.isArray(traces) || traces.length < 20) {
        return {
            error: `need at least 20 trajectory traces for analysis (have ${traces ? traces.length : 0})`,
            n: traces ? traces.length : 0
        };
    }

    // Filter out recovered historical records that lack live in-flight samples
    const validTraces = traces.filter((t) => !t.recovered && Number.isFinite(t.crash));
    const n = validTraces.length;

    if (n < 15) {
        return {
            error: `need at least 15 valid live-sampled traces for analysis (have ${n})`,
            n
        };
    }

    // 1. Causal Early Slope Analysis (using samples <= 300ms)
    const tracesWithEarlyFeatures = validTraces.map((t) => {
        const feats = extractEarlyFlightFeatures(t.samples, 300);
        return {
            ...t,
            ...feats
        };
    }).filter((t) => Number.isFinite(t.earlySlope));

    let slopeAnalysis = null;
    if (tracesWithEarlyFeatures.length >= 20) {
        const sorted = [...tracesWithEarlyFeatures].sort((a, b) => a.earlySlope - b.earlySlope);
        const medianSlope = sorted[Math.floor(sorted.length / 2)].earlySlope;

        const fastSlope = tracesWithEarlyFeatures.filter((t) => t.earlySlope >= medianSlope);
        const slowSlope = tracesWithEarlyFeatures.filter((t) => t.earlySlope < medianSlope);

        const hit15Fast = fastSlope.filter((t) => t.crash >= 1.50).length / (fastSlope.length || 1);
        const hit15Slow = slowSlope.filter((t) => t.crash >= 1.50).length / (slowSlope.length || 1);

        const hit20Fast = fastSlope.filter((t) => t.crash >= 2.00).length / (fastSlope.length || 1);
        const hit20Slow = slowSlope.filter((t) => t.crash >= 2.00).length / (slowSlope.length || 1);

        const diff20 = Math.abs(hit20Fast - hit20Slow);

        slopeAnalysis = {
            medianEarlySlope: Number(medianSlope.toFixed(3)),
            fastCount: fastSlope.length,
            slowCount: slowSlope.length,
            hit15WhenFast: Number(hit15Fast.toFixed(4)),
            hit15WhenSlow: Number(hit15Slow.toFixed(4)),
            hit20WhenFast: Number(hit20Fast.toFixed(4)),
            hit20WhenSlow: Number(hit20Slow.toFixed(4)),
            lift20: Number(diff20.toFixed(4)),
            significant: diff20 > 0.08 && tracesWithEarlyFeatures.length >= 50
        };
    }

    // 2. Time-to-1.2x milestone correlation with 2.0x survival
    const validWithTimeTo12 = validTraces.filter((t) => Number.isFinite(t.timeTo12) && t.timeTo12 > 0);
    let timeTo12Analysis = null;
    if (validWithTimeTo12.length >= 20) {
        const sortedTimes = [...validWithTimeTo12].sort((a, b) => a.timeTo12 - b.timeTo12);
        const medianTime = sortedTimes[Math.floor(sortedTimes.length / 2)].timeTo12;

        const fast12 = validWithTimeTo12.filter((t) => t.timeTo12 < medianTime);
        const slow12 = validWithTimeTo12.filter((t) => t.timeTo12 >= medianTime);

        const rateFast = fast12.filter((t) => t.crash >= 2.00).length / (fast12.length || 1);
        const rateSlow = slow12.filter((t) => t.crash >= 2.00).length / (slow12.length || 1);
        const diff = Math.abs(rateFast - rateSlow);

        timeTo12Analysis = {
            medianTimeTo12Ms: medianTime,
            sampleFast: fast12.length,
            sampleSlow: slow12.length,
            hitRate20WhenFast: Number(rateFast.toFixed(4)),
            hitRate20WhenSlow: Number(rateSlow.toFixed(4)),
            rateDifference: Number(diff.toFixed(4)),
            significant: diff > 0.08 && validWithTimeTo12.length >= 50
        };
    }

    // 3. Inter-round interval vs crash distribution (clean: non-recovered rounds only)
    const validWithInterval = validTraces.filter((t) => Number.isFinite(t.interRoundIntervalMs) && t.interRoundIntervalMs >= 1000);
    let intervalAnalysis = null;
    if (validWithInterval.length >= 20) {
        const sortedInt = [...validWithInterval].sort((a, b) => a.interRoundIntervalMs - b.interRoundIntervalMs);
        const medInt = sortedInt[Math.floor(sortedInt.length / 2)].interRoundIntervalMs;
        const quickRounds = validWithInterval.filter((t) => t.interRoundIntervalMs < medInt);
        const delayedRounds = validWithInterval.filter((t) => t.interRoundIntervalMs >= medInt);

        const avgCrashQuick = quickRounds.length ? quickRounds.reduce((s, t) => s + t.crash, 0) / quickRounds.length : 0;
        const avgCrashDelayed = delayedRounds.length ? delayedRounds.reduce((s, t) => s + t.crash, 0) / delayedRounds.length : 0;

        const hit13Quick = quickRounds.filter((t) => t.crash >= 1.30).length / (quickRounds.length || 1);
        const hit13Delayed = delayedRounds.filter((t) => t.crash >= 1.30).length / (delayedRounds.length || 1);
        const diff13 = Math.abs(hit13Quick - hit13Delayed);

        intervalAnalysis = {
            medianIntervalMs: medInt,
            quickRoundsCount: quickRounds.length,
            delayedRoundsCount: delayedRounds.length,
            avgCrashQuick: Number(avgCrashQuick.toFixed(2)),
            avgCrashDelayed: Number(avgCrashDelayed.toFixed(2)),
            hitRate13Quick: Number(hit13Quick.toFixed(4)),
            hitRate13Delayed: Number(hit13Delayed.toFixed(4)),
            lift13: Number(diff13.toFixed(4)),
            significant: diff13 > 0.08 && validWithInterval.length >= 50
        };
    }

    const flags = [];
    if (slopeAnalysis && slopeAnalysis.significant) {
        flags.push(`Early slope (<=300ms) correlates with 2.0x survival (lift ${(slopeAnalysis.lift20 * 100).toFixed(1)}%)`);
    }
    if (timeTo12Analysis && timeTo12Analysis.significant) {
        flags.push(`Time-to-1.2x predicts 2.0x survival (fast: ${(timeTo12Analysis.hitRate20WhenFast * 100).toFixed(1)}% vs slow: ${(timeTo12Analysis.hitRate20WhenSlow * 100).toFixed(1)}%)`);
    }
    if (intervalAnalysis && intervalAnalysis.significant) {
        flags.push(`Inter-round interval correlates with 1.3x hit rate (lift ${(intervalAnalysis.lift13 * 100).toFixed(1)}%)`);
    }

    const verdict = flags.length > 0 ? 'MICROSTRUCTURE_DEPENDENCE_CANDIDATE' : 'NO_MICROSTRUCTURE_EFFECT_DETECTED';

    return {
        n,
        tracesWithEarlyFeatures: tracesWithEarlyFeatures.length,
        tracesWithTimeTo12: validWithTimeTo12.length,
        tracesWithInterval: validWithInterval.length,
        earlySlopeAnalysis: slopeAnalysis,
        timeTo12Analysis,
        interRoundIntervalAnalysis: intervalAnalysis,
        flags,
        verdict,
        summary: verdict === 'NO_MICROSTRUCTURE_EFFECT_DETECTED'
            ? `Microstructure analysis shows early flight slope, milestone timing, and inter-round intervals do not predict final crash outcomes.`
            : `Microstructure candidate flagged: ${flags.join('; ')}.`
    };
}

module.exports = {
    extractEarlyFlightFeatures,
    analyzeTrajectories,
    analyzeTrajectoryStream: analyzeTrajectories
};
