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

/** Serialize a fitted model together with its feature-column mapping. */
function logisticToJson(model, colIdx, featureNames, meta = {}) {
    return {
        kind: 'logistic-v1',
        mean: model.mean,
        std: model.std,
        w: model.w,
        b: model.b,
        colIdx,
        featureNames,
        meta
    };
}

/**
 * Restore a model whose predict() takes a FEATURE OBJECT ({name: value})
 * instead of a raw row — that is the shape the live Brain produces.
 */
function logisticFromJson(json) {
    if (!json || json.kind !== 'logistic-v1') return null;
    const { mean, std, w, b, colIdx, featureNames } = json;
    const predict = (featureObj) => {
        let s = b;
        for (let j = 0; j < colIdx.length; j++) {
            const v = Number(featureObj[featureNames[colIdx[j]]]);
            const x = Number.isFinite(v) ? v : mean[j]; // missing feature -> train mean
            s += w[j] * ((x - mean[j]) / std[j]);
        }
        return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, s))));
    };
    return { predict, meta: json.meta || {}, featureNames };
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
 * Non-parametric bootstrap CI for Brier skill (resampling paired rows keeps
 * the model/null comparison on identical rounds). Deterministic when given a
 * seeded rng.
 */
function bootstrapSkillCi(modelPreds, nullPreds, outcomes, { iters = 500, rng = Math.random } = {}) {
    const n = modelPreds.length;
    if (n < 20) return null;
    const point = brierSkill(brierScore(modelPreds, outcomes), brierScore(nullPreds, outcomes));
    const skills = [];
    for (let it = 0; it < iters; it++) {
        const mp = [], np = [], oc = [];
        for (let i = 0; i < n; i++) {
            const k = Math.floor(rng() * n);
            mp.push(modelPreds[k]); np.push(nullPreds[k]); oc.push(outcomes[k]);
        }
        const s = brierSkill(brierScore(mp, oc), brierScore(np, oc));
        if (Number.isFinite(s)) skills.push(s);
    }
    if (skills.length < 20) return null;
    skills.sort((a, b) => a - b);
    const q = (p) => skills[Math.min(skills.length - 1, Math.floor(p * skills.length))];
    return { point, lo: q(0.025), hi: q(0.975), iters: skills.length };
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
        return logisticFromJson(JSON.parse(fs.readFileSync(featureModelPath(dataDir, siteId), 'utf8')));
    } catch (error) { return null; }
}

module.exports = {
    fitLogistic,
    logisticToJson,
    logisticFromJson,
    brierScore,
    brierSkill,
    bootstrapSkillCi,
    hitRatePValue,
    normCdf,
    lookElsewherePenalty,
    writeModelVerdict,
    readModelVerdict,
    saveFeatureModel,
    loadFeatureModel
};
