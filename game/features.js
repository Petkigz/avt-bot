'use strict';

/**
 * features.js — compact feature snapshot of the round stream.
 *
 * A pure function of past crash values (plus the target multiplier that
 * defines "low") and causal microstructural trajectory measurements.
 * Attached to every logged prediction so that error analysis and the model
 * tournament can rigorously test whether ANY of these features carries
 * predictive out-of-sample edge.
 */

const r3 = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);

/** Bump whenever the feature set below changes shape or meaning: deployed
 *  models carry the version they were trained on, and the Brain refuses a
 *  model whose version differs (a stale feature mapping would silently feed
 *  the model the wrong inputs). */
const FEATURE_VERSION = 2;

/** L/M/H symbols, same bins as the pattern detector. */
function symbolOf(v) {
    if (v < 1.5) return 'L';
    if (v < 2.5) return 'M';
    return 'H';
}

function mean(values) {
    if (!values || values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return s / values.length;
}

function std(values) {
    if (!values || values.length < 2) return null;
    const m = mean(values);
    let s = 0;
    for (const v of values) s += (v - m) * (v - m);
    return Math.sqrt(s / values.length);
}

function median(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rate(values, predicate) {
    if (!values || values.length === 0) return null;
    let hits = 0;
    for (const v of values) if (predicate(v)) hits += 1;
    return hits / values.length;
}

function shannonEntropy(symbols) {
    if (!symbols || symbols.length === 0) return null;
    const counts = {};
    for (const s of symbols) counts[s] = (counts[s] || 0) + 1;
    let h = 0;
    for (const key of Object.keys(counts)) {
        const p = counts[key] / symbols.length;
        h -= p * Math.log2(p);
    }
    return h;
}

/**
 * Extract the feature vector for the stream's current state.
 * `values` = chronological crash history (oldest first).
 * `target` = current strategy target multiplier.
 * `extraContext` = optional trajectory traces & inter-round metadata.
 */
function extractFeatures(values, target = 1.3, extraContext = {}) {
    const f = {};
    if (!Array.isArray(values) || values.length === 0) return f;
    const n = values.length;

    // Raw recent values
    for (let k = 1; k <= 5; k++) {
        f[`last_${k}`] = n >= k ? r3(values[n - k]) : null;
    }

    // Distribution shape over rolling windows
    const w5 = values.slice(-5);
    const w10 = values.slice(-10);
    const w25 = values.slice(-25);
    const w100 = values.slice(-100);
    f.rolling_mean_5 = r3(mean(w5));
    f.rolling_mean_10 = r3(mean(w10));
    f.rolling_mean_25 = r3(mean(w25));
    f.median_10 = r3(median(w10));
    f.std_10 = r3(std(w10));
    f.std_25 = r3(std(w25));

    // Low/high incidence (low = below the betting target)
    const isLow = (v) => v < target;
    const isHigh = (v) => v >= 2.0;
    f.low_rate_10 = r3(rate(w10, isLow));
    f.low_rate_25 = r3(rate(w25, isLow));
    f.low_rate_100 = r3(rate(w100, isLow));
    f.high_rate_10 = r3(rate(w10, isHigh));
    f.high_rate_25 = r3(rate(w25, isHigh));
    f.high_rate_100 = r3(rate(w100, isHigh));

    // Streak structure
    let consecutiveLow = 0;
    for (let i = n - 1; i >= 0; i--) {
        if (values[i] < target) consecutiveLow += 1; else break;
    }
    f.consecutive_low = consecutiveLow;

    let sinceHigh = n; // capped by available history
    for (let i = n - 1; i >= 0; i--) {
        if (values[i] >= 2.0) { sinceHigh = n - 1 - i; break; }
    }
    f.rounds_since_high = sinceHigh;

    // Symbol entropy over the last 30 rounds (max ~1.585 for 3 symbols)
    f.entropy_30 = r3(shannonEntropy(values.slice(-30).map(symbolOf)));

    // Drift: is the recent stream colder/warmer than the longer one?
    const shortLow = rate(w10, isLow);
    const longLow = rate(w100, isLow);
    f.recent_vs_long_low = (shortLow === null || longLow === null) ? null : r3(shortLow - longLow);

    // Microstructure & Trajectory features (populated when real traces/timing are available)
    const ctx = extraContext || {};
    const traces = ctx.traces || ctx.trajectoryHistory || [];
    if (Array.isArray(traces) && traces.length > 0) {
        const validTraces = traces.filter((t) => Array.isArray(t) && t.length >= 2);
        const recentTraces = validTraces.slice(-3);
        if (recentTraces.length > 0) {
            const slopes = [];
            const accels = [];
            for (const tr of recentTraces) {
                const p0 = tr[0];
                const pEarly = tr.find((p) => p && p.t >= 200 && p.t <= 500) || tr[tr.length - 1];
                if (p0 && pEarly && pEarly.t > p0.t) {
                    const dt = (pEarly.t - p0.t) / 1000;
                    const dv = pEarly.v - p0.v;
                    const slope = dv / dt;
                    slopes.push(slope);
                    accels.push(slope / dt);
                }
            }
            f.early_slope_avg_3 = slopes.length > 0 ? r3(mean(slopes)) : 0;
            f.early_accel_avg_3 = accels.length > 0 ? r3(mean(accels)) : 0;
        } else {
            f.early_slope_avg_3 = 0;
            f.early_accel_avg_3 = 0;
        }
    } else {
        f.early_slope_avg_3 = 0;
        f.early_accel_avg_3 = 0;
    }

    // Inter-round timing features
    if (Number.isFinite(ctx.interRoundDelaySec)) {
        f.inter_round_delay = r3(ctx.interRoundDelaySec);
    } else if (Number.isFinite(ctx.interRoundIntervalMs)) {
        f.inter_round_delay = r3(ctx.interRoundIntervalMs / 1000);
    } else {
        f.inter_round_delay = 0;
    }

    f.time_to_12_last = Number.isFinite(ctx.timeTo12) ? r3(ctx.timeTo12) : 0;
    f.time_to_15_last = Number.isFinite(ctx.timeTo15) ? r3(ctx.timeTo15) : 0;

    return f;
}

module.exports = { extractFeatures, symbolOf, FEATURE_VERSION };
