'use strict';

/**
 * Error analysis — intelligence-ladder step #2.
 *
 * The engine logs EVERY prediction it makes and how it settled
 * (data/predictions-<site>.jsonl). This harness studies the engine's OWN
 * settled track record and answers, per site:
 *
 *   1. ACCURACY  — is the engine's probability more accurate than simply
 *      quoting the stream base rate? (Brier skill score; >0 beats climatology)
 *   2. CALIBRATION — reliability table + Expected Calibration Error: when it
 *      says 0.80, does the round win ~80%? Direction of any drift.
 *   3. WHERE IT FAILS — error concentration by regime/tier buckets.
 *   4. EXPLORATORY — which stream-state features correlate with outcomes
 *      (Holm-Bonferroni guarded; in-sample by nature — hypothesis GENERATOR
 *      only; anything interesting must survive walk-forward before use).
 *
 * HONEST FRAMING: this does not create signal. It measures how well the
 * engine knows what it doesn't know, and points future research at the
 * error structure. Negative results here are results too.
 *
 * Usage:  npm run error:analysis
 *         npm run error:analysis -- --site betpawa.ug
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const PredictionLogger = require('../game/predictionLogger');
const { normCdf, holmBonferroni } = require('./walk-forward');

const MIN_PAIRS = 100; // below this, calibration numbers are noise

// ---------------------------------------------------------------------------
// Pairing: every 'settle' line belongs to the most recent 'predict' line
// for the same site+target that hasn't been settled yet.
// ---------------------------------------------------------------------------
function pairRecords(records) {
    const open = new Map(); // "site|target" -> latest predict record
    const pairs = [];
    for (const r of records) {
        if (r.kind === 'predict') {
            open.set(`${r.site}|${r.target}`, r);
        } else if (r.kind === 'settle') {
            const key = `${r.site}|${r.target}`;
            const pred = open.get(key);
            open.delete(key);
            // A settle is self-contained (it carries prob + outcome); the
            // matching predict only enriches it with features/tier/regime.
            pairs.push({
                site: r.site,
                target: r.target,
                prob: Number.isFinite(r.prob) ? r.prob : (pred ? pred.prob : null),
                crash: r.crash,
                won: r.won === true,
                tier: pred ? pred.tier : null,
                regime: pred ? pred.regime : '',
                allowed: pred ? !!pred.allowed : null,
                features: pred && pred.features ? pred.features : null,
                ts: r.ts
            });
        }
    }
    return pairs.filter((p) => Number.isFinite(p.prob) && p.prob > 0 && p.prob < 1);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function brier(pairs, probKey = 'prob') {
    if (pairs.length === 0) return null;
    let s = 0;
    for (const p of pairs) {
        const d = p[probKey] - (p.won ? 1 : 0);
        s += d * d;
    }
    return s / pairs.length;
}

function reliability(pairs, bins = 10) {
    const table = Array.from({ length: bins }, (_, i) => ({
        lo: i / bins, hi: (i + 1) / bins, n: 0, meanPred: 0, realized: 0
    }));
    for (const p of pairs) {
        const idx = Math.min(bins - 1, Math.floor(p.prob * bins));
        const b = table[idx];
        b.n += 1;
        b.meanPred += p.prob;
        b.realized += p.won ? 1 : 0;
    }
    let ece = 0;
    const n = pairs.length;
    for (const b of table) {
        if (b.n === 0) { b.meanPred = null; b.realized = null; b.gap = null; continue; }
        b.meanPred /= b.n;
        b.realized /= b.n;
        b.gap = b.realized - b.meanPred;
        ece += (b.n / n) * Math.abs(b.gap);
    }
    return { table, ece };
}

function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return { r: null, p: null };
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx <= 0 || syy <= 0) return { r: null, p: null };
    const r = sxy / Math.sqrt(sxx * syy);
    const rc = Math.min(0.999999, Math.max(-0.999999, r));
    const z = Math.abs(rc) * Math.sqrt((n - 2) / (1 - rc * rc));
    return { r, p: 2 * (1 - normCdf(z)), n };
}

function featureScan(pairs) {
    const withFeatures = pairs.filter((p) => p.features && typeof p.features === 'object');
    if (withFeatures.length < MIN_PAIRS) return { skipped: true, reason: `only ${withFeatures.length} rows carry feature snapshots (need ${MIN_PAIRS})` };
    const names = new Set();
    for (const p of withFeatures) for (const k of Object.keys(p.features)) names.add(k);
    const rows = [];
    for (const name of names) {
        const xs = [], ys = [];
        for (const p of withFeatures) {
            const v = p.features[name];
            if (Number.isFinite(v)) { xs.push(v); ys.push(p.won ? 1 : 0); }
        }
        const { r, p, n } = pearson(xs, ys);
        if (r !== null) rows.push({ feature: name, r, p, n });
    }
    const verdicts = holmBonferroni(rows.map((x) => x.p));
    rows.forEach((row, i) => { row.significant = verdicts[i]; });
    rows.sort((a, b) => a.p - b.p);
    return { skipped: false, n: withFeatures.length, rows };
}

// ---------------------------------------------------------------------------
// Per-site report
// ---------------------------------------------------------------------------
function analyzeSite(siteId, records) {
    const pairs = pairRecords(records);
    const report = { site: siteId, pairs: pairs.length, ts: Date.now() };
    if (pairs.length < MIN_PAIRS) {
        report.verdict = `INSUFFICIENT DATA: ${pairs.length} settled predictions (need ${MIN_PAIRS}) — keep observing.`;
        return report;
    }

    const wins = pairs.filter((p) => p.won).length;
    const baseRate = wins / pairs.length;
    const meanProb = pairs.reduce((s, p) => s + p.prob, 0) / pairs.length;

    const bModel = brier(pairs);
    // Climatology baseline: always quote the realized base rate.
    const bBase = baseRate * (1 - baseRate) ** 2 + (1 - baseRate) * baseRate ** 2;
    const brierSkill = bBase > 0 ? 1 - bModel / bBase : null;

    const { table, ece } = reliability(pairs);
    const gaps = table.filter((b) => b.gap !== null).map((b) => b.gap);
    const meanGap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;

    // Error concentration by tier
    const byTier = {};
    for (const p of pairs) {
        const k = p.tier || 'unknown';
        if (!byTier[k]) byTier[k] = { n: 0, wins: 0, se: 0, probSum: 0 };
        byTier[k].n += 1;
        byTier[k].wins += p.won ? 1 : 0;
        byTier[k].probSum += p.prob;
        const d = p.prob - (p.won ? 1 : 0);
        byTier[k].se += d * d;
    }
    for (const k of Object.keys(byTier)) {
        const t = byTier[k];
        t.winRate = t.wins / t.n;
        t.meanProb = t.probSum / t.n;
        t.brier = t.se / t.n;
        delete t.se; delete t.probSum; delete t.wins;
    }

    const features = featureScan(pairs);

    let verdict;
    if (brierSkill !== null && brierSkill > 0.02 && ece < 0.06) {
        verdict = 'CALIBRATED: the engine\'s probabilities beat the flat base-rate guess and track realized frequencies closely.';
    } else if (brierSkill !== null && brierSkill > 0) {
        verdict = 'PARTIAL: probabilities beat the base-rate guess but calibration drift is visible (see reliability table).';
    } else {
        verdict = 'NO CALIBRATION EDGE: the engine\'s probabilities are no more accurate than quoting the stream base rate. This is consistent with the walk-forward NO SIGNAL verdict.';
    }
    report.baseRate = round4(baseRate);
    report.meanProb = round4(meanProb);
    report.brierModel = round4(bModel);
    report.brierBaseRate = round4(bBase);
    report.brierSkill = brierSkill === null ? null : round4(brierSkill);
    report.ece = round4(ece);
    report.meanGap = round4(meanGap);
    report.calibrationDirection = meanGap > 0.02 ? 'under-confident (wins more than predicted)'
        : meanGap < -0.02 ? 'over-confident (wins less than predicted)'
            : 'well-centered';
    report.reliability = table.map((b) => b.n === 0 ? null : {
        bin: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, n: b.n,
        predicted: round4(b.meanPred), realized: round4(b.realized), gap: round4(b.gap)
    }).filter(Boolean);
    report.byTier = byTier;
    report.features = features;
    report.verdict = verdict;
    return report;
}

function round4(x) { return x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000; }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function listPredictionLogs(dataDir) {
    try {
        return fs.readdirSync(dataDir).filter((f) => /^predictions-.+\.jsonl$/.test(f));
    } catch (error) { return []; }
}

function printReport(rep) {
    console.log('='.repeat(70));
    console.log(`ERROR ANALYSIS — ${rep.site}   (${rep.pairs} settled predictions)`);
    console.log('='.repeat(70));
    if (rep.pairs < MIN_PAIRS) { console.log(rep.verdict); return; }
    console.log(`Base rate (wins): ${(rep.baseRate * 100).toFixed(1)}%   mean predicted: ${(rep.meanProb * 100).toFixed(1)}%`);
    console.log(`Brier: model ${rep.brierModel} vs base-rate ${rep.brierBaseRate} -> skill ${rep.brierSkill === null ? 'n/a' : (rep.brierSkill * 100).toFixed(1) + '%'}  (positive = better than the flat guess)`);
    console.log(`Expected calibration error: ${(rep.ece * 100).toFixed(1)} pts   direction: ${rep.calibrationDirection}`);
    console.log('\nReliability (predicted vs realized):');
    for (const b of rep.reliability) {
        console.log(`  ${b.bin}: n=${String(b.n).padStart(4)}  predicted ${(b.predicted * 100).toFixed(0).padStart(3)}%  realized ${(b.realized * 100).toFixed(0).padStart(3)}%  gap ${(b.gap >= 0 ? '+' : '') + (b.gap * 100).toFixed(1)}pts`);
    }
    console.log('\nBy tier:');
    for (const [tier, t] of Object.entries(rep.byTier)) {
        console.log(`  ${tier}: n=${t.n}  win ${(t.winRate * 100).toFixed(1)}%  meanProb ${(t.meanProb * 100).toFixed(1)}%  brier ${round4(t.brier)}`);
    }
    if (rep.features && rep.features.skipped) {
        console.log(`\nFeature scan: ${rep.features.reason}`);
    } else if (rep.features && rep.features.rows) {
        console.log(`\nFeature-outcome correlations (exploratory, Holm-guarded; n=${rep.features.n}):`);
        const sig = rep.features.rows.filter((r) => r.significant);
        if (sig.length === 0) {
            console.log('  none significant — no stream-state feature carries detectable outcome information.');
        } else {
            for (const r of sig) console.log(`  ${r.feature}: r=${r.r.toFixed(3)} p=${r.p.toExponential(2)}  SIGNIFICANT`);
        }
        console.log('  top 5 by |r|:');
        for (const r of [...rep.features.rows].sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 5)) {
            console.log(`    ${r.feature}: r=${r.r.toFixed(3)} p=${r.p.toExponential(2)}${r.significant ? '  *' : ''}`);
        }
    }
    console.log(`\nVERDICT: ${rep.verdict}`);
}

function main() {
    const args = process.argv.slice(2);
    const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
    const siteId = arg('--site');
    const dataDir = config.DATA_DIR;

    const logs = listPredictionLogs(dataDir).filter((f) => {
        if (!siteId) return true;
        const safe = String(siteId).replace(/[^a-z0-9.-]/gi, '-');
        return f === `predictions-${safe}.jsonl`;
    });
    if (logs.length === 0) {
        console.log(`No prediction logs found in ${dataDir} (expected predictions-<site>.jsonl). Run the bot in paper mode to accumulate settled predictions.`);
        return;
    }
    for (const file of logs) {
        const site = file.replace(/^predictions-/, '').replace(/\.jsonl$/, '');
        const logger = new PredictionLogger(path.join(dataDir, file));
        const report = analyzeSite(site, logger.readAll());
        printReport(report);
        try {
            const out = path.join(dataDir, `error-analysis-${site}.json`);
            fs.writeFileSync(out, JSON.stringify(report, null, 2));
            console.log(`\nSaved: ${out}\n`);
        } catch (error) { /* report on screen is enough */ }
    }
}

if (require.main === module) main();

module.exports = { pairRecords, analyzeSite, reliability, pearson, MIN_PAIRS };
