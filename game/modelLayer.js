'use strict';

/**
 * modelLayer.js — Phase-3 feature-model deployment layer.
 *
 * The research harnesses (scripts/walk-forward.js, scripts/feature-eval.js)
 * answer "is there ANY exploitable signal in this stream?". This module is the
 * DEPLOYMENT half: a trained, serializable model that the live Brain can
 * consume — but ONLY when the out-of-sample evidence is positive.
 *
 * Pipeline (scripts/train-model.js drives it):
 *    logged feature snapshots + outcomes
 *       -> time-series split (train / UNTOUCHED final-third holdout)
 *       -> logistic model over all features (L2, train-stats standardization)
 *       -> holdout evaluation: Brier skill vs the base-rate null, block
 *          bootstrap CI, hit-rate z-test, economic break-even check
 *       -> verdict { DEPLOY | NO_SIGNAL | INSUFFICIENT_DATA } persisted
 *
 * First-class principle: the model is ALLOWED to say NO SIGNAL. A negative
 * verdict means the Brain keeps running discipline-only gates — that is a
 * correct, intelligent output, not a failure.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Logistic regression (hand-rolled, dependency-free). Standardization uses
// TRAIN statistics only; the serialized model carries them so live inference
// reproduces the exact same scale.
// ---------------------------------------------------------------------------

function fitLogistic(X, y, colIdx, opts = {}) {
    const { l2 = 1e-2, lr = 0.1, iters = 300 } = opts;
    const n = X.length;
    const d = colIdx.length;
    if (n < 30 || d === 0) return null;

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
// Platt calibration — the deployment layer's probability corrector.
// Brier evaluation MEASURES accuracy; it does not CALIBRATE. A model can
// systematically say 0.82 when the true frequency is 0.77 and still look
// decent on skill scores. Platt scaling fits a 1-parameter+intercept logistic
// map raw-p -> outcome on a time segment EARLIER than the untouched holdout,
// so the holdout judges the CALIBRATED output.
// ---------------------------------------------------------------------------

function fitPlatt(probs, outcomes, opts = {}) {
    const { lr = 0.1, iters = 500, l2 = 5e-3 } = opts;
    const n = probs.length;
    if (n < 30) return null;
    // Platt scaling operates in LOGIT space: calibrate(p) = sigmoid(a*logit(p)+b).
    // (Fitting the affine map on raw probability cannot spread a compressed
    // distribution back out — the logit is the correct working scale.)
    const EPS = 1e-6;
    const logits = probs.map((p) => {
        const c = Math.min(1 - EPS, Math.max(EPS, p));
        return Math.log(c / (1 - c));
    });
    // Platt's Bayesian targets (Platt 1999, sec. 2.2): shrink the 0/1 targets
    // toward the interior so a small calibration sample cannot drag the map
    // around by chance. Combined with an L2 pull toward the identity map
    // (a=1, b=0), the calibrator only moves when the data DEMANDS it —
    // "first, do no harm" for a well-calibrated model.
    const nPlus = outcomes.reduce((s, v) => s + (v ? 1 : 0), 0);
    const nMinus = n - nPlus;
    const hiTarget = (nPlus + 1) / (nPlus + 2);
    const loTarget = 1 / (nMinus + 2);
    let a = 1, b = 0;
    for (let it = 0; it < iters; it++) {
        let ga = 0, gb = 0;
        for (let i = 0; i < n; i++) {
            const t = outcomes[i] ? hiTarget : loTarget;
            const s = a * logits[i] + b;
            const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
            const err = p - t;
            ga += err * logits[i];
            gb += err;
        }
        a -= lr * (ga / n + l2 * (a - 1));
        b -= lr * (gb / n + l2 * b);
    }
    const calibrate = (p) => {
        const c = Math.min(1 - EPS, Math.max(EPS, p));
        const z = Math.log(c / (1 - c));
        const s = a * z + b;
        return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
    };
    return { a, b, calibrate };
}

// ---------------------------------------------------------------------------
// Gradient-boosted depth-2 trees (hand-rolled, log loss) — the non-linear,
// feature-interacting contestant of the model tournament. Returns the forest
// in JSON-safe form so a winning model can be serialized and deployed live.
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
        thresholds.push([vals[Math.floor(n / 3)], vals[Math.floor((2 * n) / 3)]]);
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
    return { predict, mean, std, f0, lr, forest };
}

function boostingToJson(model, colIdx, featureNames, meta = {}, platt = null) {
    return {
        kind: 'boosting-v1',
        mean: model.mean, std: model.std, f0: model.f0, lr: model.lr,
        forest: model.forest, colIdx, featureNames,
        platt: platt ? { a: platt.a, b: platt.b } : null,
        meta
    };
}

// ---------------------------------------------------------------------------
// Pattern-map model (tournament contestant): mined k-symbol sequences with a
// live-proven record. Serialized as win/used counts; predict() falls back to
// the base rate for any sequence without enough evidence — an unproven
// pattern must never fake confidence.
// ---------------------------------------------------------------------------

function patternModelToJson({ window, base, map }, featureNames, meta = {}) {
    return { kind: 'pattern-v1', window, base, map, featureNames, meta };
}

// ---------------------------------------------------------------------------
// Universal model loading: the Brain calls .predict(featureObject) regardless
// of which contestant won the tournament. Missing features impute to the
// training mean; calibration (if saved) is applied last.
// ---------------------------------------------------------------------------

function modelFromJson(json) {
    if (!json || typeof json !== 'object') return null;
    if (json.kind === 'logistic-v1') return logisticFromJson(json);

    const EPS = 1e-6;
    const calibrate = json.platt && Number.isFinite(json.platt.a) && Number.isFinite(json.platt.b)
        ? (p) => {
            const c = Math.min(1 - EPS, Math.max(EPS, p));
            const z = Math.log(c / (1 - c));
            return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, json.platt.a * z + json.platt.b))));
        }
        : null;

    if (json.kind === 'boosting-v1') {
        const { mean, std, f0, lr, forest, colIdx, featureNames } = json;
        const sigmoid = (s) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
        const raw = (featureObj) => {
            const row = colIdx.map((_, j) => {
                const v = Number(featureObj[featureNames[colIdx[j]]]);
                return Number.isFinite(v) ? v : mean[j];
            });
            const zOf = (j) => (row[j] - mean[j]) / std[j];
            const predictNode = (node) =>
                (node.v !== undefined) ? node.v
                    : (zOf(node.j) <= node.thr ? predictNode(node.l) : predictNode(node.r));
            let s = f0;
            for (const tree of forest) s += lr * predictNode(tree);
            return sigmoid(s);
        };
        const predict = calibrate ? (o) => calibrate(raw(o)) : raw;
        return { predict, rawPredict: raw, calibrate, meta: json.meta || {}, featureNames };
    }

    if (json.kind === 'pattern-v1') {
        const { window, base, map } = json;
        const raw = (featureObj) => {
            // Symbols come from last_<k> features: last_3 is OLDEST, last_1 newest.
            const syms = [];
            for (let k = window; k >= 1; k--) {
                const v = Number(featureObj[`last_${k}`]);
                if (!Number.isFinite(v)) return base;
                syms.push(v < 1.5 ? 'L' : v < 2.5 ? 'M' : 'H');
            }
            const rec = map[syms.join('')];
            if (!rec || !(rec.used >= 8)) return base;
            return rec.wins / rec.used;
        };
        const predict = calibrate ? (o) => calibrate(raw(o)) : raw;
        return { predict, rawPredict: raw, calibrate, meta: json.meta || {}, featureNames: json.featureNames || [] };
    }
    return null;
}

/** Serialize a fitted model together with its feature-column mapping. */
function logisticToJson(model, colIdx, featureNames, meta = {}, platt = null) {
    return {
        kind: 'logistic-v1',
        mean: model.mean,
        std: model.std,
        w: model.w,
        b: model.b,
        colIdx,
        featureNames,
        platt: platt ? { a: platt.a, b: platt.b } : null,
        meta
    };
}

/**
 * Restore a model whose predict() takes a FEATURE OBJECT ({name: value})
 * instead of a raw row — that is the shape the live Brain produces. If the
 * model was saved with a Platt calibrator, predict() returns the CALIBRATED
 * probability (raw logit -> raw p -> calibrated p).
 */
function logisticFromJson(json) {
    if (!json || json.kind !== 'logistic-v1') return null;
    const { mean, std, w, b, colIdx, featureNames, platt } = json;
    const raw = (featureObj) => {
        let s = b;
        for (let j = 0; j < colIdx.length; j++) {
            const v = Number(featureObj[featureNames[colIdx[j]]]);
            const x = Number.isFinite(v) ? v : mean[j]; // missing feature -> train mean
            s += w[j] * ((x - mean[j]) / std[j]);
        }
        return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
    };
    const EPS = 1e-6;
    const calibrate = platt && Number.isFinite(platt.a) && Number.isFinite(platt.b)
        ? (p) => {
            const c = Math.min(1 - EPS, Math.max(EPS, p));
            const z = Math.log(c / (1 - c));
            return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, platt.a * z + platt.b))));
        }
        : null;
    const predict = calibrate ? (obj) => calibrate(raw(obj)) : raw;
    return { predict, rawPredict: raw, calibrate, meta: json.meta || {}, featureNames };
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

function brierScore(preds, outcomes) {
    const n = preds.length;
    if (n === 0) return null;
    let s = 0;
    for (let i = 0; i < n; i++) s += (preds[i] - outcomes[i]) ** 2;
    return s / n;
}

/**
 * Brier skill of the model vs a null model: positive = model is more
 * accurate than the null. Both Brier scores must be finite.
 */
function brierSkill(modelBrier, nullBrier) {
    if (!Number.isFinite(modelBrier) || !Number.isFinite(nullBrier) || nullBrier === 0) return null;
    return (nullBrier - modelBrier) / nullBrier;
}

/**
 * Generates Moving Block Bootstrap (MBB) indices of length n.
 * Blocks of contiguous elements preserve autocorrelation and streak dependence.
 */
function movingBlockBootstrapIndices(n, blockSize, rng = Math.random) {
    const indices = [];
    const b = Math.max(1, Math.min(n, Math.floor(blockSize || Math.ceil(Math.cbrt(n)))));
    const maxStart = n - b;
    while (indices.length < n) {
        const start = maxStart > 0 ? Math.floor(rng() * (maxStart + 1)) : 0;
        for (let k = 0; k < b && indices.length < n; k++) {
            indices.push(start + k);
        }
    }
    return indices;
}

/**
 * Generates Stationary Bootstrap indices (Politis & Romano, 1994) with mean block length p=1/meanBlock.
 * Preserves stationarity and geometric block lengths.
 */
function stationaryBootstrapIndices(n, meanBlock = 8, rng = Math.random) {
    const indices = [];
    const pJump = 1 / Math.max(1, meanBlock);
    let curr = Math.floor(rng() * n);
    while (indices.length < n) {
        indices.push(curr);
        if (rng() < pJump) {
            curr = Math.floor(rng() * n);
        } else {
            curr = (curr + 1) % n;
        }
    }
    return indices;
}

/**
 * Temporal Moving Block Bootstrap (MBB) & Stationary Bootstrap CI for Brier skill.
 * Resampling contiguous blocks preserves autocorrelation, runs, and sequence
 * dependencies — preventing over-optimistic i.i.d. intervals on time series.
 *
 * `nullPreds` may be a SINGLE null (array of numbers) or a list of null
 * models (array of arrays): with several nulls the skill is measured against
 * the BEST null in each sample.
 */
function bootstrapSkillCi(modelPreds, nullPreds, outcomes, {
    iters = 500,
    rng = Math.random,
    blockSize = null,
    method = 'block'
} = {}) {
    const n = modelPreds.length;
    if (n < 20) return null;
    const nulls = Number.isFinite(nullPreds[0]) ? [nullPreds] : nullPreds;
    const bestNullBrier = Math.min(...nulls.map((np) => brierScore(np, outcomes)));
    const point = brierSkill(brierScore(modelPreds, outcomes), bestNullBrier);
    const effectiveBlock = blockSize || Math.max(3, Math.min(30, Math.ceil(Math.cbrt(n))));
    const skills = [];

    for (let it = 0; it < iters; it++) {
        const idx = method === 'stationary'
            ? stationaryBootstrapIndices(n, effectiveBlock, rng)
            : (method === 'iid'
                ? Array.from({ length: n }, () => Math.floor(rng() * n))
                : movingBlockBootstrapIndices(n, effectiveBlock, rng));

        const mp = new Array(n);
        const oc = new Array(n);
        const nps = nulls.map(() => new Array(n));

        for (let i = 0; i < n; i++) {
            const k = idx[i];
            mp[i] = modelPreds[k];
            oc[i] = outcomes[k];
            for (let j = 0; j < nulls.length; j++) {
                nps[j][i] = nulls[j][k];
            }
        }

        const best = Math.min(...nps.map((np) => brierScore(np, oc)));
        const s = brierSkill(brierScore(mp, oc), best);
        if (Number.isFinite(s)) skills.push(s);
    }

    if (skills.length < 20) return null;
    skills.sort((a, b) => a - b);
    const q = (p) => skills[Math.min(skills.length - 1, Math.floor(p * skills.length))];
    return {
        point,
        lo: q(0.025),
        hi: q(0.975),
        iters: skills.length,
        method,
        blockSize: effectiveBlock
    };
}

/** One-sided z-test: does hitRate exceed baseRate? Returns p-value. */
function hitRatePValue(hits, n, baseRate) {
    if (n <= 0 || !(baseRate > 0 && baseRate < 1)) return 1;
    const p = hits / n;
    const se = Math.sqrt((baseRate * (1 - baseRate)) / n);
    if (se === 0) return 1;
    const z = (p - baseRate) / se;
    return 1 - normCdf(z);
}

function normCdf(z) {
    // Abramowitz & Stegun 26.2.17 — returns P(Z <= z) for a standard normal.
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z >= 0 ? 1 - q : q;
}

/**
 * Multiple-Model Family-Wise Error Rate (FWER) control via Holm-Bonferroni stepdown.
 * Corrects for the look-elsewhere effect when selecting the best of K contestants in a tournament.
 */
function multiModelHolmAdjustment(contestantSkillEntries) {
    // contestantSkillEntries = [ { name, skill, pValue, ciLo, ciHi }, ... ]
    const m = contestantSkillEntries.length;
    if (m <= 1) return contestantSkillEntries;

    // Sort ascending by unadjusted p-value
    const indexed = contestantSkillEntries.map((e, i) => ({ ...e, origIndex: i }))
        .sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1));

    let maxAdjustedP = 0;
    const adjusted = [];
    for (let k = 0; k < m; k++) {
        const item = indexed[k];
        const unadjP = item.pValue ?? 1;
        const multiplier = m - k;
        const rawAdjP = Math.min(1.0, unadjP * multiplier);
        maxAdjustedP = Math.max(maxAdjustedP, rawAdjP); // enforce monotonicity
        adjusted.push({
            ...item,
            adjustedPValue: Number(maxAdjustedP.toFixed(4)),
            significantFwer: maxAdjustedP < 0.05
        });
    }

    return adjusted.sort((a, b) => a.origIndex - b.origIndex);
}

// ---------------------------------------------------------------------------
// Pattern look-elsewhere correction
// ---------------------------------------------------------------------------

/**
 * Multiple-testing penalty for pattern mining: with `searched` candidate
 * patterns, some will look good by chance. A promoted pattern's Wilson lower
 * bound must clear the base rate by at least this margin
 * (Bernstein-style: shrinks as live evidence `used` accumulates).
 */
function lookElsewherePenalty(used, searched) {
    if (!Number.isFinite(used) || used <= 0) return Infinity;
    const k = Math.max(2, Math.floor(searched || 2));
    return Math.sqrt((2 * Math.log(k)) / used);
}

// ---------------------------------------------------------------------------
// Simple persistence nulls (review #8): the feature model must beat not just
// a crude historical average but the BEST simple statistical estimator —
// including recency, which the existing walk-forward variants already use.
// ---------------------------------------------------------------------------

/**
 * Walking recent-window base-rate predictions for the holdout. Strictly
 * online: each prediction uses only outcomes BEFORE that round (the tail of
 * the training segment seeds the window). This is the strongest "no
 * intelligence" comparator we can field cheaply.
 */
function recentWindowNullPreds(priorOutcomes, holdoutOutcomes, window = 50) {
    const buf = (priorOutcomes || []).slice(-window);
    const preds = [];
    for (let i = 0; i < holdoutOutcomes.length; i++) {
        const base = buf.length > 0
            ? buf.reduce((s, v) => s + v, 0) / buf.length
            : 0.5;
        preds.push(base);
        buf.push(holdoutOutcomes[i]);
        if (buf.length > window) buf.shift();
    }
    return preds;
}

/**
 * Expanding-window all-time base rate null predictions. Strictly online:
 * at index i, the predicted probability uses only outcomes strictly before
 * i (from priorOutcomes plus currentOutcomes[0..i-1]). Zero future lookahead.
 */
function expandingMeanNullPreds(priorOutcomes, currentOutcomes, defaultPrior = 0.5) {
    let sum = (priorOutcomes || []).reduce((s, v) => s + v, 0);
    let count = (priorOutcomes || []).length;
    const preds = [];
    for (let i = 0; i < currentOutcomes.length; i++) {
        preds.push(count > 0 ? sum / count : defaultPrior);
        sum += currentOutcomes[i];
        count++;
    }
    return preds;
}

/**
 * Model staleness check: a deployed model is only trusted on data like what
 * it was trained on. Once the settled record count grows past the training
 * corpus by more than `retrainAfterRounds`, the verdict is stale and the
 * Brain must fall back to discipline-only until retraining re-validates.
 */
function modelStaleness(verdict, currentSettledRows, retrainAfterRounds) {
    if (!verdict || !Number.isFinite(verdict.rowsAtTraining)) {
        return { stale: false, newRows: 0, reason: 'no training metadata' };
    }
    const newRows = Math.max(0, currentSettledRows - verdict.rowsAtTraining);
    return {
        stale: newRows > retrainAfterRounds,
        newRows,
        reason: newRows > retrainAfterRounds
            ? `${newRows} settled rounds since training exceeds the ${retrainAfterRounds}-round freshness limit`
            : `${newRows} settled rounds since training (limit ${retrainAfterRounds})`
    };
}

// ---------------------------------------------------------------------------
// Verdict + model persistence (per site)
// ---------------------------------------------------------------------------

function modelVerdictPath(dataDir, siteId) {
    return path.join(dataDir, `model-verdict-${String(siteId).replace(/[^a-z0-9._-]/gi, '_')}.json`);
}
function featureModelPath(dataDir, siteId) {
    return path.join(dataDir, `feature-model-${String(siteId).replace(/[^a-z0-9._-]/gi, '_')}.json`);
}

function writeModelVerdict(dataDir, siteId, verdict) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(modelVerdictPath(dataDir, siteId), JSON.stringify({ ...verdict, ts: Date.now() }, null, 2));
}
function readModelVerdict(dataDir, siteId) {
    try {
        return JSON.parse(fs.readFileSync(modelVerdictPath(dataDir, siteId), 'utf8'));
    } catch (error) { return null; }
}
function saveFeatureModel(dataDir, siteId, json) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(featureModelPath(dataDir, siteId), JSON.stringify(json, null, 2));
}
function loadFeatureModel(dataDir, siteId) {
    try {
        return modelFromJson(JSON.parse(fs.readFileSync(featureModelPath(dataDir, siteId), 'utf8')));
    } catch (error) { return null; }
}
function retireFeatureModel(dataDir, siteId) {
    const p = featureModelPath(dataDir, siteId);
    try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (error) { /* ignore */ }
}

function tournamentVerdictPath(dataDir, siteId) {
    return path.join(dataDir, `tournament-verdict-${String(siteId).replace(/[^a-z0-9._-]/gi, '_')}.json`);
}
function writeTournamentVerdict(dataDir, siteId, verdict) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tournamentVerdictPath(dataDir, siteId), JSON.stringify({ ...verdict, ts: Date.now() }, null, 2));
}
function readTournamentVerdict(dataDir, siteId) {
    try {
        return JSON.parse(fs.readFileSync(tournamentVerdictPath(dataDir, siteId), 'utf8'));
    } catch (error) { return null; }
}

module.exports = {
    fitLogistic,
    fitPlatt,
    fitBoosting,
    logisticToJson,
    logisticFromJson,
    boostingToJson,
    patternModelToJson,
    modelFromJson,
    brierScore,
    brierSkill,
    bootstrapSkillCi,
    movingBlockBootstrapIndices,
    stationaryBootstrapIndices,
    multiModelHolmAdjustment,
    hitRatePValue,
    normCdf,
    lookElsewherePenalty,
    recentWindowNullPreds,
    expandingMeanNullPreds,
    modelStaleness,
    writeModelVerdict,
    readModelVerdict,
    saveFeatureModel,
    loadFeatureModel,
    retireFeatureModel,
    writeTournamentVerdict,
    readTournamentVerdict
};
