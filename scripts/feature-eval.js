'use strict';

/**
 * feature-eval.js — OUT-OF-SAMPLE feature-model null test (Phase 3 research).
 *
 * The walk-forward harness answers "do the live predictor's estimator family
 * beat the base rate?". This harness asks the NEXT question the review
 * demands: do the logged stream FEATURES carry any predictive information,
 * and which ones?
 *
 * Protocol (strict, no peeking):
 *   - features are computed from rounds strictly BEFORE the predicted round
 *     (game/features.extractFeatures — same snapshots attached to the live
 *     prediction log);
 *   - expanding-window walk-forward: models train on [0, split), test on
 *     [split, split+fold); the test fold never influences fitting;
 *   - models under test:
 *       baseline          — training base rate only (the null);
 *       logistic-all      — L2 logistic regression over ALL features
 *                           (hand-rolled gradient descent, no deps);
 *       boost-all         — gradient-boosted depth-2 trees over ALL
 *                           features (hand-rolled, log loss, no deps) —
 *                           a genuinely non-linear, interacting family;
 *       logistic-<name>   — one univariate logistic model PER feature, so
 *                           each feature gets its own OOS lift table row;
 *   - every comparison is a z-test of OOS bet hit-rate vs the OOS base rate;
 *   - ALL p-values go through Holm-Bonferroni together (full model + every
 *     feature), so a lucky single feature cannot fake significance.
 *
 * Self-test: on synthetic provably-random rounds every model and every
 * feature must come back with ~zero OOS lift. If one doesn't, the harness
 * itself is broken.
 *
 * Verdict policy: like walk-forward, this is a RESEARCH instrument. Its
 * verdict does not unlock betting — the live gate stays on the walk-forward
 * verdict. A positive feature verdict is the trigger to BUILD a live feature
 * model (Phase 3); a negative one is valuable evidence that the stream
 * contains no usable feature information.
 */

const fs = require('fs');
const path = require('path');
const { extractFeatures } = require('../game/features');
const { normCdf, holmBonferroni, generateSynthetic, loadRecordedHistory, listSiteHistories } = require('./walk-forward');

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/** One row per predictable round: features of everything BEFORE it, label
 *  = whether that round reached the target. Rows with incomplete features
 *  (very start of the stream) are dropped. */
function buildDataset(values, target, minHistory = 30) {
    const rows = [];
    let names = null;
    for (let i = minHistory; i < values.length; i++) {
        const feats = extractFeatures(values.slice(0, i), target);
        const keys = Object.keys(feats);
        if (names === null) names = keys;
        if (keys.length !== names.length) continue;
        let complete = true;
        const x = new Array(names.length);
        for (let k = 0; k < names.length; k++) {
            const v = feats[names[k]];
            if (v === null || v === undefined || !Number.isFinite(v)) { complete = false; break; }
            x[k] = v;
        }
        if (!complete) continue;
        rows.push({ x, y: values[i] >= target ? 1 : 0 });
    }
    return { rows, names: names || [] };
}

// ---------------------------------------------------------------------------
// Logistic regression (hand-rolled: standardize on TRAIN stats only,
// L2-penalised gradient descent, bias term)
// ---------------------------------------------------------------------------

function fitLogistic(X, y, colIdx, opts = {}) {
    const { l2 = 1e-2, lr = 0.1, iters = 300 } = opts;
    const n = X.length;
    const d = colIdx.length;
    if (n < 30 || d === 0) return null;

    // Standardization from training data only — never peek at the test fold.
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (let j = 0; j < d; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += X[i][colIdx[j]];
        mean[j] = s / n;
        let v = 0;
        for (let i = 0; i < n; i++) v += (X[i][colIdx[j]] - mean[j]) ** 2;
        std[j] = Math.sqrt(v / n) || 1;
    }
    const z = (i, j) => (X[i][colIdx[j]] - mean[j]) / std[j];

    const w = new Array(d).fill(0);
    let b = 0;
    for (let it = 0; it < iters; it++) {
        const gw = new Array(d).fill(0);
        let gb = 0;
        for (let i = 0; i < n; i++) {
            let s = b;
            for (let j = 0; j < d; j++) s += w[j] * z(i, j);
            const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
            const err = p - y[i];
            for (let j = 0; j < d; j++) gw[j] += err * z(i, j);
            gb += err;
        }
        for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
        b -= lr * (gb / n);
    }
    const predict = (row) => {
        let s = b;
        for (let j = 0; j < d; j++) s += w[j] * ((row[colIdx[j]] - mean[j]) / std[j]);
        return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
    };
    return { predict, mean, std, w, b };
}

// ---------------------------------------------------------------------------
// Gradient-boosted depth-2 trees (hand-rolled, log loss). A genuinely
// different model family from logistic regression: non-linear, feature-
// interacting. Used ONLY out-of-sample, compared against the same null,
// and corrected together with every other model via Holm-Bonferroni.
// ---------------------------------------------------------------------------

function fitBoosting(X, y, colIdx, opts = {}) {
    const { trees = 50, lr = 0.1, minChild = 10 } = opts;
    const n = X.length;
    const d = colIdx.length;
    if (n < 60 || d === 0) return null;

    // Standardization from training data only — never peek at the test fold.
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (let j = 0; j < d; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += X[i][colIdx[j]];
        mean[j] = s / n;
        let v = 0;
        for (let i = 0; i < n; i++) v += (X[i][colIdx[j]] - mean[j]) ** 2;
        std[j] = Math.sqrt(v / n) || 1;
    }
    const zOf = (row, j) => (row[colIdx[j]] - mean[j]) / std[j];

    // Split candidates: terciles of each standardized feature (train only).
    const thresholds = [];
    for (let j = 0; j < d; j++) {
        const vals = [];
        for (let i = 0; i < n; i++) vals.push(zOf(X[i], j));
        vals.sort((a, b) => a - b);
        thresholds.push([
            vals[Math.floor(n / 3)],
            vals[Math.floor((2 * n) / 3)]
        ]);
    }

    const sigmoid = (s) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
    const base = Math.max(1e-6, Math.min(1 - 1e-6, y.reduce((s, v) => s + v, 0) / n));
    const f0 = Math.log(base / (1 - base));
    const f = new Array(n).fill(f0);
    const forest = [];

    const sseOf = (idx, resid) => {
        let s = 0, sq = 0;
        for (const i of idx) { s += resid[i]; sq += resid[i] * resid[i]; }
        return { s, sse: sq - (s * s) / idx.length };
    };

    const allIdx = [];
    for (let i = 0; i < n; i++) allIdx.push(i);

    for (let m = 0; m < trees; m++) {
        // Negative gradient of log loss = the regression target.
        const resid = new Array(n);
        for (let i = 0; i < n; i++) resid[i] = y[i] - sigmoid(f[i]);

        const fitNode = (idx, depth) => {
            const here = sseOf(idx, resid);
            const leafV = here.s / idx.length;
            if (depth >= 2 || idx.length < 2 * minChild) return { v: leafV };
            let best = null;
            for (let j = 0; j < d; j++) {
                for (const thr of thresholds[j]) {
                    const L = [], R = [];
                    for (const i of idx) (zOf(X[i], j) <= thr ? L : R).push(i);
                    if (L.length < minChild || R.length < minChild) continue;
                    const sse = sseOf(L, resid).sse + sseOf(R, resid).sse;
                    const gain = here.sse - sse;
                    if (gain > 1e-12 && (!best || gain > best.gain)) best = { j, thr, L, R, gain };
                }
            }
            if (!best) return { v: leafV };
            return { j: best.j, thr: best.thr, l: fitNode(best.L, depth + 1), r: fitNode(best.R, depth + 1) };
        };
        const tree = fitNode(allIdx, 0);
        forest.push(tree);

        const predictNode = (node, row) =>
            (node.v !== undefined) ? node.v
                : (zOf(row, node.j) <= node.thr ? predictNode(node.l, row) : predictNode(node.r, row));
        for (let i = 0; i < n; i++) f[i] += lr * predictNode(tree, X[i]);
    }

    const predictNodeOf = (node, row) =>
        (node.v !== undefined) ? node.v
            : (zOf(row, node.j) <= node.thr ? predictNodeOf(node.l, row) : predictNodeOf(node.r, row));
    const predict = (row) => {
        let s = f0;
        for (const tree of forest) s += lr * predictNodeOf(tree, row);
        return sigmoid(s);
    };
    return { predict };
}

// ---------------------------------------------------------------------------
// Walk-forward evaluation
// ---------------------------------------------------------------------------

function runFeatureEval(values, opts = {}) {
    const target = opts.target ?? 1.3;
    const minTrain = opts.minTrain ?? 150;
    const foldSize = opts.foldSize ?? 50;
    const entryFloor = opts.entryFloor ?? 0.6;
    const margin = opts.margin ?? 0.02;

    const { rows, names } = buildDataset(values, target);
    if (rows.length < minTrain + foldSize) {
        return { error: `only ${rows.length} feature rows — need at least ${minTrain + foldSize}` };
    }

    const baseRateAll = rows.reduce((s, r) => s + r.y, 0) / rows.length;
    const allCols = names.map((_, j) => j);
    // Models: two genuinely different model families over ALL features
    // (linear logistic + non-linear gradient boosting), plus one univariate
    // logistic per feature (the feature-importance table).
    const models = [
        { name: 'logistic-all', cols: allCols, kind: 'logistic' },
        { name: 'boost-all', cols: allCols, kind: 'boost' }
    ];
    for (let j = 0; j < names.length; j++) models.push({ name: `logistic-${names[j]}`, cols: [j], kind: 'logistic' });

    const acc = {};
    for (const m of [{ name: 'baseline', cols: [] }, ...models]) {
        acc[m.name] = { bets: 0, wins: 0, brierSum: 0, logLossSum: 0, tests: 0 };
    }

    let folds = 0;
    let testHits = 0;
    let totalTest = 0;
    for (let split = minTrain; split + foldSize <= rows.length; split += foldSize) {
        folds += 1;
        const train = rows.slice(0, split);
        const test = rows.slice(split, split + foldSize);
        const trainBase = train.reduce((s, r) => s + r.y, 0) / train.length;

        const fitted = {};
        for (const m of models) {
            const trainX = train.map((r) => r.x);
            const trainY = train.map((r) => r.y);
            fitted[m.name] = m.kind === 'boost'
                ? fitBoosting(trainX, trainY, m.cols)
                : fitLogistic(trainX, trainY, m.cols);
        }

        for (const row of test) {
            totalTest += 1;
            testHits += row.y;
            const ests = { baseline: trainBase };
            for (const m of models) {
                ests[m.name] = fitted[m.name] ? fitted[m.name].predict(row.x) : null;
            }
            for (const name of Object.keys(acc)) {
                const e = ests[name];
                const a = acc[name];
                if (e === null) continue;
                a.tests += 1;
                const clamped = Math.min(1 - 1e-9, Math.max(1e-9, e));
                a.brierSum += (e - row.y) ** 2;
                a.logLossSum += -(row.y * Math.log(clamped) + (1 - row.y) * Math.log(1 - clamped));
                if (name === 'baseline') {
                    if (e >= trainBase + margin) { a.bets += 1; if (row.y) a.wins += 1; }
                } else if (e >= entryFloor) {
                    a.bets += 1;
                    if (row.y) a.wins += 1;
                }
            }
        }
    }

    const oosBaseRate = testHits / totalTest;

    // Significance per model, then Holm-Bonferroni over ALL of them together.
    const raw = Object.keys(acc).map((name) => {
        const a = acc[name];
        const hitRate = a.bets > 0 ? a.wins / a.bets : null;
        let pValue = null;
        if (name !== 'baseline' && a.bets >= 30 && hitRate !== null && oosBaseRate > 0 && oosBaseRate < 1) {
            const z = (hitRate - oosBaseRate) / Math.sqrt((oosBaseRate * (1 - oosBaseRate)) / a.bets);
            pValue = 2 * (1 - normCdf(Math.abs(z)));
        }
        return { name, a, hitRate, pValue, lift: hitRate !== null ? hitRate - oosBaseRate : null };
    });
    const keep = holmBonferroni(raw.map((r) => r.pValue), 0.05);

    const modelsOut = {};
    let signalDetected = false;
    raw.forEach((r, i) => {
        const significant = r.pValue !== null && keep[i] && r.lift > 0;
        if (significant) signalDetected = true;
        modelsOut[r.name] = {
            bets: r.a.bets,
            wins: r.a.wins,
            hitRate: r.hitRate !== null ? Number(r.hitRate.toFixed(4)) : null,
            lift: r.lift !== null ? Number(r.lift.toFixed(4)) : null,
            pValue: r.pValue !== null ? Number(r.pValue.toFixed(4)) : null,
            significant,
            brier: r.a.tests > 0 ? Number((r.a.brierSum / r.a.tests).toFixed(5)) : null,
            logLoss: r.a.tests > 0 ? Number((r.a.logLossSum / r.a.tests).toFixed(5)) : null
        };
    });

    const baselineBrier = modelsOut.baseline ? modelsOut.baseline.brier : null;
    const featureLifts = names
        .map((nm) => ({ feature: nm, ...(modelsOut[`logistic-${nm}`] || {}) }))
        .sort((a, b) => (b.lift ?? -1) - (a.lift ?? -1));

    return {
        rounds: values.length,
        featureRows: rows.length,
        features: names.length,
        folds,
        target,
        oosBaseRate: Number(oosBaseRate.toFixed(4)),
        correction: `holm-bonferroni over ${raw.filter((r) => r.pValue !== null).length} model comparisons`,
        models: modelsOut,
        featureLifts,
        baselineBrier,
        signalDetected,
        verdict: signalDetected
            ? 'FEATURE SIGNAL CANDIDATE — a model beat the null out-of-sample after multiple-testing correction. Re-verify on fresh data before building anything live.'
            : 'NO FEATURE SIGNAL — no feature model beat the null out-of-sample. Features carry no measurable predictive information in this stream (so far).'
    };
}

/** Persist the feature verdict (research record; the LIVE bet gate stays on
 *  the walk-forward verdict by design). */
function writeFeatureVerdict(dataDir, siteId, report) {
    try {
        const file = path.join(dataDir, `feature-verdict-${String(siteId).replace(/[^a-z0-9.-]/gi, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify({ siteId, ts: Date.now(), ...report }, null, 2));
        return file;
    } catch (error) { return null; }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printReport(report, source) {
    if (report.error) { console.log(`  ${source}: ${report.error}`); return; }
    console.log(`\nFeature null-test — ${source} (${report.featureRows} rows, ${report.features} features, ${report.folds} folds, target ${report.target}x, OOS base ${(report.oosBaseRate * 100).toFixed(1)}%)`);
    console.log('model                bets  hitRate    lift     p     brier   logLoss');
    for (const [name, r] of Object.entries(report.models)) {
        const hr = r.hitRate === null ? '  -   ' : `${(r.hitRate * 100).toFixed(1).padStart(5)}%`;
        const lift = r.lift === null ? '   -   ' : `${(r.lift * 100 >= 0 ? '+' : '') + (r.lift * 100).toFixed(1)}%`.padStart(7);
        const pv = r.pValue === null ? ' n/a ' : r.pValue.toFixed(3).padStart(5);
        console.log(
            `${name.padEnd(20)} ${String(r.bets).padStart(5)}  ${hr}  ${lift}  ${pv}  ${(r.brier ?? 0).toFixed(4)}  ${(r.logLoss ?? 0).toFixed(4)}` +
            (r.significant ? '   << significant OOS lift' : '')
        );
    }
    console.log(`\nFeature OOS lift table (best first; all corrected via ${report.correction}):`);
    for (const f of report.featureLifts.slice(0, 10)) {
        const lift = f.lift === null ? '   -  ' : `${(f.lift * 100 >= 0 ? '+' : '') + (f.lift * 100).toFixed(2)}%`;
        console.log(`  ${f.feature.padEnd(24)} ${lift}${f.significant ? '  << significant' : ''}`);
    }
    console.log(`\nVERDICT: ${report.verdict}`);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
    const dataDir = arg('--data') || path.join(__dirname, '..', 'data');
    const target = parseFloat(arg('--target') || process.env.WALKFORWARD_TARGET || '1.3');
    const siteId = arg('--site');

    const runOne = (sid, values, source) => {
        const report = runFeatureEval(values, { target });
        printReport(report, source);
        if (!report.error && sid) {
            const file = writeFeatureVerdict(dataDir, sid, report);
            if (file) console.log(`Feature verdict stored: ${file}`);
        }
    };

    if (siteId) {
        const { values, source } = loadRecordedHistory(dataDir, siteId);
        runOne(siteId, values, source || siteId);
    } else {
        const sites = listSiteHistories(dataDir);
        if (sites.length === 0) {
            console.log('No recorded history. Self-testing on SYNTHETIC random rounds (known answer: no feature carries information):');
            runOne(null, generateSynthetic(3000, 0.03, 20260923), 'synthetic 3000 rounds (ground truth: no signal)');
        }
        for (const { siteId: sid, values } of sites) runOne(sid, values, sid);
    }
}

module.exports = { runFeatureEval, buildDataset, fitLogistic, writeFeatureVerdict };
