'use strict';

/**
 * features.js — compact feature snapshot of the round stream.
 *
 * A pure function of past crash values (plus the target multiplier that
 * defines "low"). Attached to every logged prediction so that, once enough
 * rounds accumulate, error analysis can test whether ANY of these features
 * carries predictive information about the next round.
 *
 * No feature here is assumed to be useful — that is exactly what the
 * walk-forward harness and the prediction log exist to decide. Until then
 * this module just makes the recorded evidence richer.
 */

const r3 = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);

/** L/M/H symbols, same bins as the pattern detector. */
function symbolOf(v) {
    if (v < 1.5) return 'L';
    if (v < 2.5) return 'M';
    return 'H';
}

function mean(values) {
    if (values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return s / values.length;
}

function std(values) {
    if (values.length < 2) return null;
    const m = mean(values);
    let s = 0;
    for (const v of values) s += (v - m) * (v - m);
    return Math.sqrt(s / values.length);
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rate(values, predicate) {
    if (values.length === 0) return null;
    let hits = 0;
    for (const v of values) if (predicate(v)) hits += 1;
    return hits / values.length;
}

function shannonEntropy(symbols) {
    if (symbols.length === 0) return null;
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
 */
function extractFeatures(values, target = 1.3) {
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

    return f;
}

module.exports = { extractFeatures, symbolOf };
