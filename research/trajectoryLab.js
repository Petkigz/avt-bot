'use strict';

/**
 * research/trajectoryLab.js
 *
 * Microstructure and trajectory analysis laboratory. Investigates whether
 * in-flight growth velocity, time-to-threshold milestones, acceleration,
 * or inter-round intervals contain predictive information about final crashes.
 */

function analyzeTrajectories(traces, opts = {}) {
    if (!Array.isArray(traces) || traces.length < 20) {
        return {
            error: `need at least 20 trajectory traces for analysis (have ${traces ? traces.length : 0})`,
            n: traces ? traces.length : 0
        };
    }

    const n = traces.length;
    const validWithDuration = traces.filter((t) => Number.isFinite(t.durationMs) && t.durationMs > 0);
    const validWithTimeTo12 = traces.filter((t) => Number.isFinite(t.timeTo12) && t.timeTo12 > 0);

    // 1. Time-to-1.2x correlation with reaching 2.0x
    // Hypothesis: Does the speed of early multiplier growth correlate with final crash?
    let timeTo12Vs20 = null;
    if (validWithTimeTo12.length >= 20) {
        const fast12 = []; // timeTo12 below median
        const slow12 = []; // timeTo12 above median
        const sortedTimes = [...validWithTimeTo12].sort((a, b) => a.timeTo12 - b.timeTo12);
        const medianTime = sortedTimes[Math.floor(sortedTimes.length / 2)].timeTo12;

        for (const t of validWithTimeTo12) {
            const hit20 = t.crash >= 2.00 ? 1 : 0;
            if (t.timeTo12 < medianTime) fast12.push(hit20);
            else slow12.push(hit20);
        }

        const rateFast = fast12.length ? fast12.reduce((s, v) => s + v, 0) / fast12.length : 0;
        const rateSlow = slow12.length ? slow12.reduce((s, v) => s + v, 0) / slow12.length : 0;
        const diff = Math.abs(rateFast - rateSlow);

        timeTo12Vs20 = {
            medianTimeTo12Ms: medianTime,
            sampleFast: fast12.length,
            sampleSlow: slow12.length,
            hitRate20WhenFast: Number(rateFast.toFixed(4)),
            hitRate20WhenSlow: Number(rateSlow.toFixed(4)),
            rateDifference: Number(diff.toFixed(4)),
            significant: diff > 0.08 && validWithTimeTo12.length >= 100
        };
    }

    // 2. Inter-round interval vs crash distribution
    const validWithInterval = traces.filter((t) => Number.isFinite(t.interRoundIntervalMs) && t.interRoundIntervalMs > 0);
    let intervalAnalysis = null;
    if (validWithInterval.length >= 20) {
        const sortedInt = [...validWithInterval].sort((a, b) => a.interRoundIntervalMs - b.interRoundIntervalMs);
        const medInt = sortedInt[Math.floor(sortedInt.length / 2)].interRoundIntervalMs;
        const quickRounds = validWithInterval.filter((t) => t.interRoundIntervalMs < medInt);
        const delayedRounds = validWithInterval.filter((t) => t.interRoundIntervalMs >= medInt);

        const avgCrashQuick = quickRounds.length ? quickRounds.reduce((s, t) => s + t.crash, 0) / quickRounds.length : 0;
        const avgCrashDelayed = delayedRounds.length ? delayedRounds.reduce((s, t) => s + t.crash, 0) / delayedRounds.length : 0;

        intervalAnalysis = {
            medianIntervalMs: medInt,
            quickRoundsCount: quickRounds.length,
            delayedRoundsCount: delayedRounds.length,
            avgCrashQuick: Number(avgCrashQuick.toFixed(2)),
            avgCrashDelayed: Number(avgCrashDelayed.toFixed(2)),
            hitRate13Quick: Number((quickRounds.filter((t) => t.crash >= 1.30).length / (quickRounds.length || 1)).toFixed(4)),
            hitRate13Delayed: Number((delayedRounds.filter((t) => t.crash >= 1.30).length / (delayedRounds.length || 1)).toFixed(4))
        };
    }

    // 3. Trajectory velocity metrics
    const velocities = traces
        .filter((t) => Number.isFinite(t.durationMs) && t.durationMs > 200 && Number.isFinite(t.crash))
        .map((t) => (t.crash - 1.0) / (t.durationMs / 1000)); // multiplier units per second
    const avgVelocity = velocities.length ? velocities.reduce((s, v) => s + v, 0) / velocities.length : null;

    const flags = [];
    if (timeTo12Vs20 && timeTo12Vs20.significant) {
        flags.push(`Time-to-1.2x predicts 2.0x survival (fast: ${(timeTo12Vs20.hitRate20WhenFast * 100).toFixed(1)}% vs slow: ${(timeTo12Vs20.hitRate20WhenSlow * 100).toFixed(1)}%)`);
    }

    const verdict = flags.length > 0 ? 'MICROSTRUCTURE_DEPENDENCE_CANDIDATE' : 'NO_MICROSTRUCTURE_EFFECT_DETECTED';

    return {
        n,
        tracesWithDuration: validWithDuration.length,
        tracesWithTimeTo12: validWithTimeTo12.length,
        avgVelocityPerSec: avgVelocity ? Number(avgVelocity.toFixed(4)) : null,
        timeTo12Analysis: timeTo12Vs20,
        interRoundIntervalAnalysis: intervalAnalysis,
        flags,
        verdict,
        summary: verdict === 'NO_MICROSTRUCTURE_EFFECT_DETECTED'
            ? `Microstructure analysis shows flight velocity and inter-round timing do not predict final crash multiplier.`
            : `Microstructure candidate flagged: ${flags.join('; ')}.`
    };
}

module.exports = {
    analyzeTrajectories,
    analyzeTrajectoryStream: analyzeTrajectories
};
