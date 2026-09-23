'use strict';

/**
 * walk-forward.js — out-of-sample validation harness.
 *
 * The core scientific question for this bot: do past crash values contain
 * ANY information about the next one? In-sample pattern mining can always
 * find "rules" in random data, so this harness never lets a model see the
 * rounds it is judged on:
 *
 *   rounds [0 .. t)        -> TRAIN (models estimate P(crash >= target))
 *   rounds [t .. t+h)      -> TEST  (bets are simulated, results scored)
 *   slide t forward by h, repeat, aggregate.
 *
 * Variants compared against each other AND against the unconditional
 * base rate of each test fold:
 *   baseline  — overall train-window rate (the honest null model)
 *   recent    — rate over the last N train rounds
 *   recency   — exponentially recency-weighted rate (half-life)
 *   wilson    — recent rate shrunk by its Wilson lower bound
 *
 * Verdict logic: a variant only counts as "signal" if its out-of-sample
 * hit rate when betting beats the test-fold base rate with p < 0.05.
 * If nothing clears that bar the harness prints the only honest answer:
 * NO PREDICTIVE SIGNAL DETECTED.
 *
 * Usage:  npm run walkforward            (uses recorded per-site history,
 *                                         falls back to synthetic rounds)
 *         npm run walkforward -- --site betpawa.ug --target 1.3
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Synthetic feed (same distribution as model-eval: 3% house edge)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function generateSynthetic(n, edge = 0.03, seed = 42) {
    const rng = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        const u = Math.max(rng(), 1e-9);
        out.push(Number(Math.max(1, (1 - edge) / u).toFixed(2)));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Estimators — each receives the TRAIN window and returns P(crash >= target)
// ---------------------------------------------------------------------------
function rateOf(values, target) {
    if (values.length === 0) return null;
    let hits = 0;
    for (const v of values) if (v >= target) hits += 1;
    return hits / values.length;
}

function recencyWeightedRate(values, target, halfLife = 30) {
    if (values.length === 0) return null;
    let wSum = 0;
    let wHits = 0;
    const n = values.length;
    for (let i = 0; i < n; i++) {
        const age = n - 1 - i;
        const w = Math.pow(0.5, age / halfLife);
        wSum += w;
        if (values[i] >= target) wHits += w;
    }
    return wHits / wSum;
}

function wilsonLower(p, n, z = 1.96) {
    if (n === 0 || p === null) return null;
    const denom = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (center - spread) / denom);
}

const VARIANTS = {
    baseline: (train, target) => rateOf(train, target),
    recent: (train, target, opts) => rateOf(train.slice(-opts.recentWindow), target),
    recency: (train, target, opts) => recencyWeightedRate(train, target, opts.halfLife),
    wilson: (train, target, opts) => {
        const window = train.slice(-opts.recentWindow);
        return wilsonLower(rateOf(window, target), window.length);
    }
};

// Normal CDF (Abramowitz-Stegun erf approximation)
function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z > 0) p = 1 - p;
    return p;
}

/** Holm-Bonferroni step-down correction. Returns a boolean array: which
 *  hypotheses stay significant after controlling the family-wise error
 *  rate across ALL of them. Null p-values (insufficient data) stay false. */
function holmBonferroni(pValues, alpha = 0.05) {
    const m = pValues.filter((p) => p !== null && Number.isFinite(p)).length;
    const keep = pValues.map(() => false);
    const order = pValues
        .map((p, i) => ({ p, i }))
        .filter((e) => e.p !== null && Number.isFinite(e.p))
        .sort((a, b) => a.p - b.p);
    for (let rank = 0; rank < order.length; rank++) {
        const threshold = alpha / (m - rank);
        if (order[rank].p <= threshold) keep[order[rank].i] = true;
        else break; // step-down: once one fails, all weaker ones fail too
    }
    return keep;
}

// ---------------------------------------------------------------------------
// Walk-forward engine
// ---------------------------------------------------------------------------
function runWalkForward(values, opts = {}) {
    const target = opts.target || 1.3;
    const trainMin = opts.trainMin || 300;
    const testSize = opts.testSize || 100;
    const stake = opts.stake || 100;
    const defaults = { recentWindow: 50, halfLife: 30, margin: 0.02 };
    const o = { ...defaults, ...opts };

    if (!Array.isArray(values) || values.length < trainMin + testSize) {
        return { error: `need at least ${trainMin + testSize} rounds, got ${Array.isArray(values) ? values.length : 0}` };
    }

    const names = Object.keys(VARIANTS);
    const acc = {};
    for (const name of names) {
        acc[name] = { bets: 0, wins: 0, pnl: 0, peak: 0, maxDD: 0, brierSum: 0, skipped: 0 };
    }
    let folds = 0;
    let totalTest = 0;
    let testHits = 0;

    for (let t = trainMin; t + testSize <= values.length; t += testSize) {
        const train = values.slice(0, t);
        const test = values.slice(t, t + testSize);
        const foldBase = rateOf(test, target);
        const trainBase = rateOf(train, target);
        folds += 1;
        totalTest += test.length;
        testHits += test.filter((v) => v >= target).length;

        // One estimate per variant for this fold (train data only).
        const estimates = {};
        for (const name of names) {
            estimates[name] = VARIANTS[name](train, target, o);
        }

        for (const v of test) {
            const won = v >= target;
            for (const name of names) {
                const est = estimates[name];
                const a = acc[name];
                if (est === null) { a.skipped += 1; continue; }
                // Brier over every test round measures estimate quality
                // regardless of whether the gate would bet.
                a.brierSum += (est - (won ? 1 : 0)) ** 2;
                if (est >= trainBase + o.margin) {
                    a.bets += 1;
                    if (won) a.wins += 1;
                    a.pnl += won ? stake * (target - 1) : -stake;
                    if (a.pnl > a.peak) a.peak = a.pnl;
                    const dd = a.peak - a.pnl;
                    if (dd > a.maxDD) a.maxDD = dd;
                }
            }
        }
    }

    const oosBaseRate = testHits / totalTest;

    // ---- Multiple-testing correction (Holm-Bonferroni) ----
    // We compare SEVERAL variants against the same base rate; testing k
    // hypotheses at p<0.05 means ~1-(0.95^k) chance of a false positive.
    // Holm's step-down procedure controls the family-wise error rate.
    const raw = names.map((name) => {
        const a = acc[name];
        const hitRate = a.bets > 0 ? a.wins / a.bets : null;
        let z = null;
        let pValue = null;
        if (a.bets >= 30 && hitRate !== null && oosBaseRate > 0 && oosBaseRate < 1) {
            z = (hitRate - oosBaseRate) / Math.sqrt((oosBaseRate * (1 - oosBaseRate)) / a.bets);
            pValue = 2 * (1 - normCdf(Math.abs(z)));
        }
        return { name, a, hitRate, z, pValue, lift: hitRate !== null ? hitRate - oosBaseRate : null };
    });
    const corrected = holmBonferroni(raw.map((r) => r.pValue), 0.05);

    const results = {};
    let signalDetected = false;
    raw.forEach((r, i) => {
        const significant = r.pValue !== null && corrected[i] && r.lift > 0;
        if (significant) signalDetected = true;
        results[r.name] = {
            bets: r.a.bets,
            wins: r.a.wins,
            hitRate: r.hitRate !== null ? Number(r.hitRate.toFixed(4)) : null,
            lift: r.lift !== null ? Number(r.lift.toFixed(4)) : null,
            pValue: r.pValue !== null ? Number(r.pValue.toFixed(4)) : null,
            significant,
            brier: Number((r.a.brierSum / totalTest).toFixed(5)),
            pnl: Number(r.a.pnl.toFixed(2)),
            maxDD: Number(r.a.maxDD.toFixed(2))
        };
    });

    return {
        rounds: values.length,
        folds,
        target,
        oosBaseRate: Number(oosBaseRate.toFixed(4)),
        correction: `holm-bonferroni over ${raw.filter((r) => r.pValue !== null).length} tested variants`,
        results,
        signalDetected,
        verdict: signalDetected
            ? 'SIGNAL CANDIDATE DETECTED — treat with suspicion until re-verified on fresh data (random data regularly produces lucky streaks).'
            : 'NO PREDICTIVE SIGNAL DETECTED — no estimator beat the base rate out-of-sample; bet gates run discipline-only.'
    };
}

// ---------------------------------------------------------------------------
// Data loading + CLI
// ---------------------------------------------------------------------------
function loadRecordedHistory(dataDir, siteId = null) {
    const readValues = (file) => {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(raw) ? raw.filter((v) => Number.isFinite(v) && v > 0) : [];
        } catch (error) { return []; }
    };
    let values = [];
    let source = '';
    try {
        const names = fs.readdirSync(dataDir).filter((f) => /^history-.+\.json$/.test(f));
        const wanted = siteId ? names.filter((f) => f === `history-${String(siteId).replace(/[^a-z0-9.-]/gi, '-')}.json`) : names;
        for (const name of wanted) values = values.concat(readValues(path.join(dataDir, name)));
        if (values.length > 0) source = siteId ? `recorded history for ${siteId}` : `recorded history (${names.length} site files)`;
        if (values.length === 0 && !siteId) {
            values = readValues(path.join(dataDir, 'history.json'));
            if (values.length > 0) source = 'legacy history.json';
        }
    } catch (error) { /* fall through to synthetic */ }
    return { values, source };
}

/** List per-site history files with their round counts (validation must run
 *  per site — bookmakers host separate Aviator streams and mixing them would
 *  corrupt the sequence analysis). */
function listSiteHistories(dataDir) {
    const readValues = (file) => {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(raw) ? raw.filter((v) => Number.isFinite(v) && v > 0) : [];
        } catch (error) { return []; }
    };
    const out = [];
    try {
        for (const name of fs.readdirSync(dataDir)) {
            const m = /^history-(.+)\.json$/.exec(name);
            if (!m) continue;
            const values = readValues(path.join(dataDir, name));
            if (values.length > 0) out.push({ siteId: m[1], values });
        }
    } catch (error) { /* no data dir */ }
    return out;
}

function printReport(report, label) {
    console.log(`\n=== Walk-forward validation — ${label} ===`);
    if (report.error) { console.log(`  ${report.error}`); return; }
    console.log(`Rounds: ${report.rounds} | folds: ${report.folds} | target: ${report.target}x | out-of-sample base rate: ${(report.oosBaseRate * 100).toFixed(1)}%`);
    console.log('variant    bets   hitRate   lift      p      Brier    pnl      maxDD');
    for (const [name, r] of Object.entries(report.results)) {
        const hr = r.hitRate === null ? '  -   ' : `${(r.hitRate * 100).toFixed(1).padStart(5)}%`;
        const lift = r.lift === null ? '   -   ' : `${(r.lift * 100 >= 0 ? '+' : '') + (r.lift * 100).toFixed(1)}%`.padStart(7);
        const pv = r.pValue === null ? ' n/a ' : r.pValue.toFixed(3).padStart(5);
        console.log(
            `${name.padEnd(10)} ${String(r.bets).padStart(5)}  ${hr}  ${lift}  ${pv}  ${r.brier.toFixed(4)}  ${String(r.pnl.toFixed(0)).padStart(7)}  ${String(r.maxDD.toFixed(0)).padStart(6)}` +
            (r.significant ? '   << significant lift' : '')
        );
    }
    console.log(`\nVERDICT: ${report.verdict}`);
}

/** Persist a site's validation verdict so the LIVE engine can act on it. */
function writeVerdict(dataDir, siteId, report) {
    const safe = String(siteId || 'unknown').replace(/[^a-z0-9.-]/gi, '-');
    const file = path.join(dataDir, `signal-verdict-${safe}.json`);
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            siteId, ts: Date.now(), rounds: report.rounds, target: report.target,
            signalDetected: report.signalDetected, verdict: report.verdict,
            results: report.results
        }, null, 2));
        return file;
    } catch (error) {
        return null;
    }
}

function readVerdict(dataDir, siteId) {
    const safe = String(siteId || 'unknown').replace(/[^a-z0-9.-]/gi, '-');
    const file = path.join(dataDir, `signal-verdict-${safe}.json`);
    try {
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : null;
    } catch (error) { return null; }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
    const dataDir = arg('--data') || path.join(__dirname, '..', 'data');
    const target = parseFloat(arg('--target') || process.env.WALKFORWARD_TARGET || '1.3');
    const siteId = arg('--site');

    if (siteId) {
        const { values, source } = loadRecordedHistory(dataDir, siteId);
        if (values.length >= 400) {
            console.log(`Data source: ${source} — ${values.length} rounds (cumulative across restarts)`);
            const report = runWalkForward(values, { target });
            printReport(report, source);
            const file = writeVerdict(dataDir, siteId, report);
            if (file) console.log(`Verdict stored for the live engine: ${file}`);
        } else {
            console.log(`${siteId} has ${values.length} recorded rounds — needs 400+ for walk-forward. Keep observing; every round persists.`);
        }
    } else {
        // No --site given: validate EACH site separately. Sites are separate
        // Aviator streams; merging them would corrupt the analysis.
        const sites = listSiteHistories(dataDir);
        if (sites.length === 0) {
            console.log('No recorded history yet. Validating on SYNTHETIC rounds (known 3% house edge — no signal exists by construction):\n');
            printReport(runWalkForward(generateSynthetic(5000, 0.03, 20260922), { target }), 'synthetic 5000 rounds (ground truth: no signal)');
        }
        for (const { siteId: sid, values } of sites) {
            if (values.length >= 400) {
                console.log(`\nData source: ${sid} — ${values.length} rounds (cumulative across restarts)`);
                const report = runWalkForward(values, { target });
                printReport(report, sid);
                const file = writeVerdict(dataDir, sid, report);
                if (file) console.log(`Verdict stored for the live engine: ${file}`);
            } else {
                console.log(`\n${sid}: ${values.length} recorded rounds — needs 400+ for walk-forward. Keep observing; every round persists.`);
            }
        }
        if (sites.length > 1) {
            console.log('\nEach site was validated separately on purpose: bookmakers run separate Aviator streams.');
        }
    }
}

module.exports = { runWalkForward, generateSynthetic, loadRecordedHistory, listSiteHistories, writeVerdict, readVerdict, holmBonferroni, normCdf, VARIANTS };
