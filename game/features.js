'use strict';

/**
 * features.js — compact feature snapshot of the round stream (Feature Version 3).
 *
 * A pure function of past crash values (plus the target multiplier that
 * defines "low") and causal microstructural trajectory measurements.
 * Attached to every logged prediction so that error analysis and the model
 * tournament can rigorously test whether ANY of these features carries
 * predictive out-of-sample edge.
 *
 * Expansions in V3:
 * - Autocorrelation at lags 1, 2, 3
 * - Markov state transitions (L/M/H) and 2-step transition probabilities
 * - Quantiles (25th, 75th, IQR) and empirical sample skewness
 * - Tail hazard rates and continuous run-length encoding
 * - Information dynamics: conditional entropy H(S_t | S_{t-1}) and surprisal
 * - House Liquidity & RTP regime state indicators
 * - Immutable Feature Factory helper: extractFeaturesFromHistory()
 */

const r3 = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);

/** Bump whenever the feature set below changes shape or meaning: deployed
 *  models carry the version they were trained on, and the Brain refuses a
 *  model whose version differs (a stale feature mapping would silently feed
 *  the model the wrong inputs). */
const FEATURE_VERSION = 3;

/** L/M/H symbols, same bins as the pattern detector. */
function symbolOf(v) {
    if (!Number.isFinite(v)) return 'M';
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

function quantile(values, q) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q));
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
}

function skewness(values) {
    if (!values || values.length < 3) return null;
    const m = mean(values);
    const s = std(values);
    if (!s || s === 0) return 0;
    const n = values.length;
    let sumCube = 0;
    for (const v of values) sumCube += Math.pow((v - m) / s, 3);
    return (n / ((n - 1) * (n - 2))) * sumCube;
}

function rate(values, predicate) {
    if (!values || values.length === 0) return null;
    let hits = 0;
    for (const v of values) if (predicate(v)) hits += 1;
    return hits / values.length;
}

function autocorr(values, lag = 1) {
    if (!values || values.length <= lag + 2) return 0;
    const m = mean(values);
    const s = std(values);
    if (!s || s === 0) return 0;
    const n = values.length;
    let cov = 0;
    for (let i = 0; i < n - lag; i++) {
        cov += (values[i] - m) * (values[i + lag] - m);
    }
    return cov / ((n - lag) * s * s);
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

function conditionalEntropy(symbols) {
    if (!symbols || symbols.length < 2) return null;
    const joint = {};
    const marginal = {};
    const n = symbols.length;
    for (let i = 0; i < n - 1; i++) {
        const s0 = symbols[i];
        const s1 = symbols[i + 1];
        marginal[s0] = (marginal[s0] || 0) + 1;
        const pair = `${s0}->${s1}`;
        joint[pair] = (joint[pair] || 0) + 1;
    }
    let condH = 0;
    for (const pair of Object.keys(joint)) {
        const s0 = pair.split('->')[0];
        const pJoint = joint[pair] / (n - 1);
        const pCond = joint[pair] / marginal[s0];
        if (pCond > 0) condH -= pJoint * Math.log2(pCond);
    }
    return condH;
}

/**
 * Extract the feature vector for the stream's current state.
 * `values` = chronological crash history (oldest first).
 * `target` = current strategy target multiplier.
 * `extraContext` = optional trajectory traces, house cycle & inter-round metadata.
 */
function extractFeatures(values, target = 1.3, extraContext = {}) {
    const f = {};
    if (!Array.isArray(values) || values.length === 0) return f;
    const n = values.length;

    // 1. Raw recent crash values
    for (let k = 1; k <= 5; k++) {
        f[`last_${k}`] = n >= k ? r3(values[n - k]) : null;
    }

    // 2. Rolling window distributions
    const w5 = values.slice(-5);
    const w10 = values.slice(-10);
    const w25 = values.slice(-25);
    const w30 = values.slice(-30);
    const w50 = values.slice(-50);
    const w100 = values.slice(-100);

    f.rolling_mean_5 = r3(mean(w5));
    f.rolling_mean_10 = r3(mean(w10));
    f.rolling_mean_25 = r3(mean(w25));
    f.median_10 = r3(median(w10));
    f.std_10 = r3(std(w10));
    f.std_25 = r3(std(w25));

    // Quantile and dispersion features
    const q25 = quantile(w30, 0.25);
    const q75 = quantile(w30, 0.75);
    f.quantile_25 = r3(q25);
    f.quantile_75 = r3(q75);
    f.iqr_30 = (q25 !== null && q75 !== null) ? r3(q75 - q25) : 0;
    f.skewness_30 = r3(skewness(w30));

    // Autocorrelation structure
    f.autocorr_lag1 = r3(autocorr(w50, 1));
    f.autocorr_lag2 = r3(autocorr(w50, 2));
    f.autocorr_lag3 = r3(autocorr(w50, 3));

    // Low/high incidence (low = below target)
    const isLow = (v) => v < target;
    const isHigh = (v) => v >= 2.0;
    f.low_rate_10 = r3(rate(w10, isLow));
    f.low_rate_25 = r3(rate(w25, isLow));
    f.low_rate_100 = r3(rate(w100, isLow));
    f.high_rate_10 = r3(rate(w10, isHigh));
    f.high_rate_25 = r3(rate(w25, isHigh));
    f.high_rate_100 = r3(rate(w100, isHigh));

    // Tail hazard rate: proportion of instant busts / low traps (<1.50x)
    f.tail_hazard_15 = r3(rate(w25, (v) => v < 1.50));

    // Streak & run length structure
    let consecutiveLow = 0;
    for (let i = n - 1; i >= 0; i--) {
        if (values[i] < target) consecutiveLow += 1; else break;
    }
    f.consecutive_low = consecutiveLow;

    let currentRunLength = 1;
    if (n >= 2) {
        const lastSym = symbolOf(values[n - 1]);
        for (let i = n - 2; i >= 0; i--) {
            if (symbolOf(values[i]) === lastSym) currentRunLength++;
            else break;
        }
    }
    f.run_length_current = currentRunLength;

    let sinceHigh = n; // capped by available history
    for (let i = n - 1; i >= 0; i--) {
        if (values[i] >= 2.0) { sinceHigh = n - 1 - i; break; }
    }
    f.rounds_since_high = sinceHigh;

    // Symbol representations and Markov transitions
    const symbols30 = values.slice(-30).map(symbolOf);
    f.entropy_30 = r3(shannonEntropy(symbols30));
    f.cond_entropy_30 = r3(conditionalEntropy(symbols30));

    const lastSym = symbols30[symbols30.length - 1];
    let toLCount = 0, toHCount = 0, fromLastTotal = 0;
    let trans2stepLL = 0, total2step = 0;
    for (let i = 0; i < symbols30.length - 1; i++) {
        if (symbols30[i] === lastSym) {
            fromLastTotal++;
            if (symbols30[i + 1] === 'L') toLCount++;
            if (symbols30[i + 1] === 'H') toHCount++;
        }
        if (i < symbols30.length - 2) {
            total2step++;
            if (symbols30[i] === 'L' && symbols30[i + 1] === 'L') trans2stepLL++;
        }
    }
    f.trans_prob_to_L = fromLastTotal > 0 ? r3(toLCount / fromLastTotal) : 0.45;
    f.trans_prob_to_H = fromLastTotal > 0 ? r3(toHCount / fromLastTotal) : 0.25;
    f.trans_2step_LL = total2step > 0 ? r3(trans2stepLL / total2step) : 0.20;

    // Surprisal of the most recent symbol
    const baseSymProb = rate(symbols30, (s) => s === lastSym);
    f.surprisal_last = (baseSymProb && baseSymProb > 0) ? r3(-Math.log2(baseSymProb)) : 1.0;

    // Drift: recent vs long low rate
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

    // House cycle indicators
    const hc = ctx.houseCycle || null;
    if (hc) {
        f.regime_intake_index = Number.isFinite(hc.intakeIndex) ? r3(hc.intakeIndex) : 0;
        f.regime_absorption_flag = hc.phase === 'HOUSE_ABSORPTION' ? 1 : 0;
        f.regime_rebate_flag = hc.phase === 'HOUSE_REBATE_DUE' ? 1 : 0;
    } else {
        f.regime_intake_index = 0;
        f.regime_absorption_flag = 0;
        f.regime_rebate_flag = 0;
    }

    return f;
}

/**
 * Immutable Feature Factory: reconstructs feature dataset strictly from raw crash history.
 * Given a chronological crash stream and target multiplier, reconstructs feature rows
 * without depending on legacy execution logs.
 */
function extractFeaturesFromHistory(history, target = 1.3, minWarmup = 30) {
    if (!Array.isArray(history) || history.length <= minWarmup) return [];
    const rows = [];
    for (let i = minWarmup; i < history.length; i++) {
        const past = history.slice(0, i);
        const nextCrash = history[i];
        const feats = extractFeatures(past, target);
        const won = nextCrash >= target;
        rows.push({
            features: feats,
            target,
            crash: nextCrash,
            won
        });
    }
    return rows;
}

module.exports = {
    extractFeatures,
    extractFeaturesFromHistory,
    symbolOf,
    FEATURE_VERSION
};

