'use strict';

/**
 * train-model.js — Phase-3: train the live feature model under a strict
 * no-peek protocol and write the deployment verdict.
 *
 * Protocol:
 *   - rows come from the permanent prediction log (predictions-<site>.jsonl),
 *     paired predict+settle records with feature snapshots;
 *   - CONDITIONED ON TARGET: rounds settled at different targets are never
 *     pooled (pooling targets fakes skill — see scripts/error-analysis.js);
 *     the dominant target is trained, the rest are reported;
 *   - time-series split: first two thirds train, newest third is an
 *     UNTOUCHED holdout — the model sees nothing from it during fitting;
 *   - the model must beat the base-rate NULL on the holdout with:
 *       * bootstrap CI of Brier skill entirely above zero, AND
 *       * significant hit-rate lift on model-approved entries (p < 0.05), AND
 *       * positive economic EV at the target (hit rate above break-even);
 *     otherwise the verdict is NO_SIGNAL and the live Brain stays
 *     discipline-only. NO SIGNAL is a first-class, correct outcome.
 *
 * Usage:
 *   node scripts/train-model.js [--site betpawa.ug] [--holdout 0.34]
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const PredictionLogger = require('../game/predictionLogger');
const { pairRecords } = require('./error-analysis');
const {
    fitLogistic, logisticToJson,
    brierScore, brierSkill, bootstrapSkillCi, hitRatePValue, normCdf,
    writeModelVerdict, saveFeatureModel
} = require('../game/modelLayer');

const MIN_HOLDOUT = 150;      // holdout rounds required before any verdict
const ENTRY_MARGIN = 0.02;    // model must bet this above break-even to count

// Deterministic RNG so the bootstrap is reproducible run-to-run.
function makeRng(seed = 42) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function rowsForSite(records, siteId) {
    return pairRecords(records).filter((r) => r.site === siteId && r.features && typeof r.features === 'object');
}

function buildMatrix(rows, names) {
    // Non-finite feature values become the column mean (computed on TRAIN
    // only — the holdout matrix is imputed with train stats inside the
    // standardization step of fitLogistic / logisticFromJson).
    const X = rows.map((r) => names.map((nm) => {
        const v = Number(r.features[nm]);
        return Number.isFinite(v) ? v : NaN;
    }));
    return X;
}

function trainAndEvaluate(rows, opts = {}) {
    const holdoutFrac = opts.holdoutFrac ?? 0.34;
    const target = rows[0].target;
    const names = Object.keys(rows[0].features);
    const split = Math.floor(rows.length * (1 - holdoutFrac));
    const trainRows = rows.slice(0, split);
    const holdoutRows = rows.slice(split);

    const trainBase = trainRows.reduce((s, r) => s + (r.won ? 1 : 0), 0) / trainRows.length;

    // Impute NaNs with TRAIN column means before fitting/evaluating.
    const Xtrain = buildMatrix(trainRows, names);
    const means = names.map((_, j) => {
        let s = 0, c = 0;
        for (let i = 0; i < Xtrain.length; i++) {
            if (Number.isFinite(Xtrain[i][j])) { s += Xtrain[i][j]; c++; }
        }
        return c > 0 ? s / c : 0;
    });
    const impute = (X) => X.forEach((row) => row.forEach((v, j) => {
        if (!Number.isFinite(v)) row[j] = means[j];
    }));
    impute(Xtrain);
    const Xhold = buildMatrix(holdoutRows, names);
    impute(Xhold);

    const yTrain = trainRows.map((r) => (r.won ? 1 : 0));
    const yHold = holdoutRows.map((r) => (r.won ? 1 : 0));
    const cols = names.map((_, j) => j);

    const model = fitLogistic(Xtrain, yTrain, cols, opts.fit);
    if (!model) {
        return { error: `training failed (n=${trainRows.length})` };
    }

    const modelPreds = Xhold.map((row) => model.predict(row));
    const nullPreds = Xhold.map(() => trainBase);

    const modelBrier = brierScore(modelPreds, yHold);
    const nullBrier = brierScore(nullPreds, yHold);
    const skill = brierSkill(modelBrier, nullBrier);
    const ci = bootstrapSkillCi(modelPreds, nullPreds, yHold, { iters: 600, rng: makeRng() });

    // Economic read: rounds the model would actually enter (its probability
    // clears break-even plus a margin). A deployed model must show realized
    // EV > 0 on precisely these entries — otherwise its "confidence" has no
    // economic content, whatever the Brier score says.
    const breakEven = 1 / target;
    const entryProb = breakEven + ENTRY_MARGIN;
    const entries = [];
    for (let i = 0; i < holdoutRows.length; i++) {
        if (modelPreds[i] >= entryProb) entries.push(yHold[i]);
    }
    const entryHits = entries.reduce((s, v) => s + v, 0);
    const entryRate = entries.length > 0 ? entryHits / entries.length : null;
    const evPerBet = entryRate === null ? null : entryRate * target - 1;
    const pEntry = entries.length > 0 ? hitRatePValue(entryHits, entries.length, breakEven) : 1;

    const holdoutBase = yHold.reduce((s, v) => s + v, 0) / yHold.length;

    let verdict;
    if (holdoutRows.length < MIN_HOLDOUT) {
        verdict = 'INSUFFICIENT_DATA';
    } else if (
        ci && ci.lo > 0 &&
        entries.length >= 30 && pEntry < 0.05 &&
        Number.isFinite(evPerBet) && evPerBet > 0
    ) {
        verdict = 'DEPLOY';
    } else {
        verdict = 'NO_SIGNAL';
    }

    return {
        verdict,
        target,
        n: rows.length,
        nTrain: trainRows.length,
        nHoldout: holdoutRows.length,
        trainBase: Number(trainBase.toFixed(4)),
        holdoutBase: Number(holdoutBase.toFixed(4)),
        brierModel: Number(modelBrier.toFixed(5)),
        brierNull: Number(nullBrier.toFixed(5)),
        brierSkill: skill === null ? null : Number(skill.toFixed(4)),
        bootstrapCi: ci ? { lo: Number(ci.lo.toFixed(4)), point: Number(ci.point.toFixed(4)), hi: Number(ci.hi.toFixed(4)) } : null,
        entryProbThreshold: Number(entryProb.toFixed(4)),
        entries: entries.length,
        entryHitRate: entryRate === null ? null : Number(entryRate.toFixed(4)),
        entryPValue: Number(pEntry.toFixed(4)),
        evPerBet: evPerBet === null ? null : Number(evPerBet.toFixed(4)),
        breakEven: Number(breakEven.toFixed(4)),
        model, cols, names
    };
}

function runSite(siteId, opts = {}) {
    const file = path.join(config.DATA_DIR, `predictions-${String(siteId).replace(/[^a-z0-9._-]/gi, '_')}.jsonl`);
    if (!fs.existsSync(file)) {
        return { site: siteId, error: `no prediction log (${path.basename(file)})` };
    }
    const records = new PredictionLogger(file).readAll();
    const all = rowsForSite(records, siteId);
    if (all.length < 100) {
        return { site: siteId, error: `only ${all.length} feature rows — need at least 100` };
    }

    // Condition on target — never pool different targets (mixing artifact).
    const byTarget = new Map();
    for (const r of all) {
        const key = Number(r.target).toFixed(2);
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key).push(r);
    }
    const targets = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length);
    const [domTarget, rows] = targets[0];

    const result = trainAndEvaluate(rows, opts);
    if (result.error) return { site: siteId, error: result.error };

    const { model, cols, names, ...report } = result;
    const reason = report.verdict === 'DEPLOY'
        ? 'model beat the base-rate null out-of-sample with positive economic value'
        : report.verdict === 'NO_SIGNAL'
            ? 'no out-of-sample edge over the base-rate null (Brier CI, hit-rate and EV gates refused deployment)'
            : `need >= ${MIN_HOLDOUT} holdout rounds before any verdict (have ${report.nHoldout})`;
    const summary = {
        site: siteId,
        dominantTarget: Number(domTarget),
        droppedTargets: targets.slice(1).map(([t, rs]) => ({ target: Number(t), rows: rs.length })),
        reason,
        ...report
    };

    writeModelVerdict(config.DATA_DIR, siteId, summary);
    if (summary.verdict === 'DEPLOY') {
        saveFeatureModel(config.DATA_DIR, siteId, logisticToJson(model, cols, names, {
            site: siteId, target: summary.target, brierSkill: summary.brierSkill, trained: new Date().toISOString()
        }));
    }
    return summary;
}

function main() {
    const args = process.argv.slice(2);
    const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;

    const files = fs.readdirSync(config.DATA_DIR).filter((f) => /^predictions-.*\.jsonl$/.test(f));
    const sites = files
        .map((f) => f.replace(/^predictions-/, '').replace(/\.jsonl$/, ''))
        .filter((s) => !siteArg || s === siteArg);
    if (sites.length === 0) {
        console.log(siteArg
            ? `No prediction log for site "${siteArg}" in ${config.DATA_DIR}.`
            : `No prediction logs found in ${config.DATA_DIR} — run the bot first.`);
        process.exit(1);
    }

    console.log('=====================================================');
    console.log(' FEATURE MODEL TRAINING (Phase 3, strict no-peek)');
    console.log('=====================================================');
    for (const site of sites) {
        const r = runSite(site);
        console.log(`\n[${r.site}]`);
        if (r.error) {
            console.log(`  skipped: ${r.error}`);
            continue;
        }
        console.log(`  rows: ${r.n} (train ${r.nTrain} / untouched holdout ${r.nHoldout}) @ target ${r.target}x` +
            (r.droppedTargets.length ? ` — other targets excluded: ${r.droppedTargets.map((d) => `${d.target}x(${d.rows})`).join(', ')}` : ''));
        console.log(`  base rate: train ${r.trainBase} | holdout ${r.holdoutBase}`);
        console.log(`  Brier skill vs null: ${r.brierSkill} (bootstrap 95% CI ${r.bootstrapCi ? `[${r.bootstrapCi.lo}, ${r.bootstrapCi.hi}]` : 'n/a'})`);
        console.log(`  model-approved entries: ${r.entries} @ P >= ${r.entryProbThreshold} — hit rate ${r.entryHitRate ?? 'n/a'} vs break-even ${r.breakEven} (p=${r.entryPValue}, EV/bet=${r.evPerBet})`);
        console.log(`  VERDICT: ${r.verdict}` +
            (r.verdict === 'DEPLOY'
                ? ' — the live Brain will use this model (it beat the null out-of-sample with economic value)'
                : r.verdict === 'NO_SIGNAL'
                    ? ' — no out-of-sample edge; the live Brain stays discipline-only. This is a CORRECT answer, not a failure.'
                    : ` — need >= ${MIN_HOLDOUT} holdout rounds; keep collecting data.`));
    }
}

if (require.main === module) main();

module.exports = { runSite, trainAndEvaluate, rowsForSite, MIN_HOLDOUT };
