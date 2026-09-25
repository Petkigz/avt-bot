'use strict';

/**
 * model-tournament.js — the model-selector layer (external review #8, "next").
 *
 * train-model.js pits ONE model (logistic) against the null. The tournament
 * settles the bigger question: of every model family we are allowed to build,
 * does ANY of it beat the best simple statistical estimator — consistently,
 * calibrated, and with money-positive entries?
 *
 * Contestants:
 *   null       — constant historical base rate (the crude average)
 *   statistical— walking recent-window base rate (the live estimator's core)
 *   logistic   — all-feature logistic regression
 *   boosting   — gradient-boosted depth-2 trees (feature interactions)
 *   pattern    — mined k-symbol sequence win rates
 *
 * Protocol (all walks forward in time; nothing from the holdout leaks back):
 *   logged feature rows, conditioned on the dominant target
 *     -> WALK-FORWARD: expanding-window folds; every model-based contestant
 *        is re-fit per fold and scored strictly out-of-sample
 *     -> CALIBRATION: Platt maps fit on each contestant's OWN out-of-sample
 *        walk predictions (adopted only if they improve Brier)
 *     -> SELECTOR: rank by Brier skill vs the best persistence null on the
 *        stitched out-of-sample predictions; the winner advances alone
 *     -> FINAL HOLDOUT: the newest third, untouched until now; the winner is
 *        re-fit on the walk zone, calibrated, and judged by the SAME four
 *        deployment gates as train-model (bootstrap CI > 0, >=30 approved
 *        entries, hit-rate p < 0.05, positive EV per approved bet)
 *     -> DEPLOY (winner serialized to the live feature-model file) or
 *        NO_SIGNAL. Either way a tournament report is written.
 *
 * A DEPLOY from the tournament reuses the exact live-loading path the Brain
 * already trusts (feature-model-<site>.json + model-verdict-<site>.json),
 * marked source:"tournament".
 *
 * Usage:
 *   node scripts/model-tournament.js [--site betpawa.ug] [--folds 5]
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const PredictionLogger = require('../game/predictionLogger');
const { FEATURE_VERSION, symbolOf } = require('../game/features');
const { pairRecords } = require('./error-analysis');
const { rowsForSite } = require('./train-model');
const { fitEnsembleWeights } = require('../game/ensemble');
const {
    fitLogistic, fitBoosting, fitPlatt,
    logisticToJson, boostingToJson, patternModelToJson,
    brierScore, brierSkill, bootstrapSkillCi, hitRatePValue,
    multiModelHolmAdjustment,
    recentWindowNullPreds, expandingMeanNullPreds,
    writeModelVerdict, saveFeatureModel, retireFeatureModel, writeTournamentVerdict
} = require('../game/modelLayer');

const MIN_HOLDOUT = 150;
const ENTRY_MARGIN = 0.02;
const RECENT_NULL_WINDOW = 50;
const MIN_FOLD = 40;          // smallest out-of-sample fold
const PATTERN_WINDOW = 3;     // symbol lookback for the pattern contestant
const PATTERN_MIN_SUPPORT = 8;

function makeRng(seed = 4242) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function buildMatrix(rows, names, means) {
    const X = rows.map((r) => names.map((nm) => {
        const v = Number(r.features[nm]);
        return Number.isFinite(v) ? v : NaN;
    }));
    if (means) {
        X.forEach((row) => row.forEach((v, j) => { if (!Number.isFinite(v)) row[j] = means[j]; }));
    }
    return X;
}
function columnMeans(X) {
    const d = X.length ? X[0].length : 0;
    return Array.from({ length: d }, (_, j) => {
        let s = 0, c = 0;
        for (const row of X) if (Number.isFinite(row[j])) { s += row[j]; c++; }
        return c > 0 ? s / c : 0;
    });
}

// ---- Contestant fitters: each returns { predict(rowArray) } or null -------
function fitContestant(name, Xtrain, yTrain, cols) {
    if (name === 'logistic') return fitLogistic(Xtrain, yTrain, cols);
    if (name === 'boosting-25') return fitBoosting(Xtrain, yTrain, cols, { trees: 25 });
    if (name === 'boosting-50' || name === 'boosting') return fitBoosting(Xtrain, yTrain, cols, { trees: 50 });
    return null;
}

// ---- Pattern contestant: k-symbol -> (wins, used) from the training rows ---
function buildPatternMap(rows, window) {
    const map = {};
    for (const r of rows) {
        const syms = [];
        let ok = true;
        // features.last_k: last_1 is the most recent; build oldest->newest.
        for (let k = window; k >= 1; k--) {
            const v = Number(r.features[`last_${k}`]);
            if (!Number.isFinite(v)) { ok = false; break; }
            syms.push(symbolOf(v));
        }
        if (!ok) continue;
        const key = syms.join('');
        if (!map[key]) map[key] = { wins: 0, used: 0 };
        map[key].used++;
        if (r.won) map[key].wins++;
    }
    return map;
}
function patternPredict(map, row, base, window) {
    const syms = [];
    for (let k = window; k >= 1; k--) {
        const v = Number(row.features[`last_${k}`]);
        if (!Number.isFinite(v)) return base;
        syms.push(symbolOf(v));
    }
    const rec = map[syms.join('')];
    if (!rec || rec.used < PATTERN_MIN_SUPPORT) return base;
    return rec.wins / rec.used;
}

/**
 * Run the full tournament over one site's paired feature rows.
 * Returns { verdict, winner, report, deployModel? }.
 */
function runTournament(rows, opts = {}) {
    const folds = opts.folds ?? 5;
    const holdoutFrac = opts.holdoutFrac ?? 0.34;
    const target = rows[0].target;
    const names = Object.keys(rows[0].features);
    const cols = names.map((_, j) => j);

    const split = Math.floor(rows.length * (1 - holdoutFrac));
    const walkRows = rows.slice(0, split);
    const holdoutRows = rows.slice(split);
    if (holdoutRows.length < MIN_HOLDOUT) {
        return { verdict: 'INSUFFICIENT_DATA', winner: null, report: { n: rows.length, nHoldout: holdoutRows.length } };
    }

    // Expanding-window walk-forward over the walk zone: (folds+1) blocks,
    // fold f trains on blocks [0..f-1] and predicts block [f].
    const block = Math.floor(walkRows.length / (folds + 1));
    if (block < MIN_FOLD) {
        return { verdict: 'INSUFFICIENT_DATA', winner: null, report: { n: rows.length, walkBlock: block } };
    }
    const segments = [];
    for (let f = 1; f <= folds; f++) {
        const trainEnd = f * block;
        const testStart = trainEnd;
        const testEnd = f === folds ? walkRows.length : (f + 1) * block;
        if (testEnd <= testStart) continue;
        segments.push({ train: walkRows.slice(0, trainEnd), test: walkRows.slice(testStart, testEnd), testStart });
    }

    // Out-of-sample prediction arrays aligned to walkRows (undefined outside
    // a contestant's test coverage).
    const contestantNames = ['logistic', 'boosting-25', 'boosting-50', 'pattern-3'];
    const preds = {};
    for (const name of contestantNames) preds[name] = new Array(walkRows.length);
    const yWalk = walkRows.map((r) => (r.won ? 1 : 0));

    for (const seg of segments) {
        const Xtrain = buildMatrix(seg.train, names);
        const means = columnMeans(Xtrain);
        const Xi = buildMatrix(seg.train, names, means);
        const yT = seg.train.map((r) => (r.won ? 1 : 0));
        const segBase = yT.length ? yT.reduce((a, b) => a + b, 0) / yT.length : 0.5;

        const models = {
            logistic: fitContestant('logistic', Xi, yT, cols),
            'boosting-25': fitContestant('boosting-25', Xi, yT, cols),
            'boosting-50': fitContestant('boosting-50', Xi, yT, cols)
        };
        const pmap = buildPatternMap(seg.train, PATTERN_WINDOW);

        const Xtest = buildMatrix(seg.test, names, means);
        seg.test.forEach((r, i) => {
            const gi = seg.testStart + i;
            if (models.logistic) preds.logistic[gi] = models.logistic.predict(Xtest[i]);
            if (models['boosting-25']) preds['boosting-25'][gi] = models['boosting-25'].predict(Xtest[i]);
            if (models['boosting-50']) preds['boosting-50'][gi] = models['boosting-50'].predict(Xtest[i]);
            preds['pattern-3'][gi] = patternPredict(pmap, r, segBase, PATTERN_WINDOW);
        });
    }

    // Persistence nulls, strictly online across the walk zone (zero lookahead).
    const nullBase = expandingMeanNullPreds([], yWalk, 1 / Number(target));
    const nullRecent = recentWindowNullPreds([], yWalk, RECENT_NULL_WINDOW);

    // Test-covered indices (where model contestants have OOS predictions).
    const idx = [];
    for (let i = 0; i < walkRows.length; i++) if (Number.isFinite(preds.logistic[i])) idx.push(i);
    if (idx.length < 60) return { verdict: 'INSUFFICIENT_DATA', winner: null, report: { oosRows: idx.length } };

    const pick = (arr) => idx.map((i) => arr[i]);
    const yOOS = pick(yWalk);
    const contestants = {
        logistic: pick(preds.logistic),
        'boosting-25': pick(preds['boosting-25']),
        'boosting-50': pick(preds['boosting-50']),
        'pattern-3': pick(preds['pattern-3']),
        statistical: pick(nullRecent),
        null: pick(nullBase)
    };

    // ---- Calibrate each model contestant on its own OOS walk predictions --
    const calibrators = {};
    for (const name of contestantNames) {
        const cand = fitPlatt(contestants[name], yOOS);
        if (cand) {
            const bRaw = brierScore(contestants[name], yOOS);
            const bCal = brierScore(contestants[name].map(cand.calibrate), yOOS);
            calibrators[name] = (Number.isFinite(bCal) && bCal < bRaw) ? cand : null;
        } else calibrators[name] = null;
    }
    const applyCal = (name, arr) => calibrators[name] ? arr.map(calibrators[name].calibrate) : arr;

    // ---- Selector: rank by Brier skill vs the BEST persistence null -------
    const bestNullOOS = Math.min(brierScore(contestants.null, yOOS), brierScore(contestants.statistical, yOOS));
    const rawEntries = [];
    const standings = {};

    for (const name of contestantNames) {
        const cal = applyCal(name, contestants[name]);
        const brier = brierScore(cal, yOOS);
        const skill = brierSkill(brier, bestNullOOS);
        const ci = bootstrapSkillCi(cal, [contestants.null, contestants.statistical], yOOS, {
            iters: 500,
            rng: makeRng(),
            method: 'block'
        });

        // Approximate one-sided p-value from bootstrap distribution or z-score
        const se = (ci && ci.hi !== null && ci.lo !== null) ? Math.max(1e-4, (ci.hi - ci.lo) / 3.92) : 1.0;
        const z = (skill !== null && se > 0) ? skill / se : -5;
        const pVal = 1 - (ci ? Math.max(0, Math.min(1, (z > 0 ? (1 / (1 + Math.exp(-1.7 * z))) : Math.exp(1.7 * z) / 2))) : 1.0);

        rawEntries.push({
            name,
            brier,
            skill,
            ci,
            calibrated: !!calibrators[name],
            pValue: pVal
        });
    }

    // Apply Multiple-Model Family-Wise Error Rate (FWER) stepdown correction
    const adjustedEntries = multiModelHolmAdjustment(rawEntries);
    for (const entry of adjustedEntries) {
        standings[entry.name] = {
            brier: entry.brier,
            skill: entry.skill,
            ci: entry.ci,
            calibrated: entry.calibrated,
            pValue: entry.pValue,
            adjustedPValue: entry.adjustedPValue,
            significantFwer: entry.significantFwer
        };
    }

    const ranked = Object.entries(standings).sort((a, b) => (b[1].skill ?? -1) - (a[1].skill ?? -1));
    const [winnerName, winnerStats] = ranked[0];

    // The winner must show POSITIVE out-of-sample skill (moving block bootstrap CI above zero)
    // on the walk before it earns a shot at the holdout.
    const walkQualified = winnerStats.ci && winnerStats.ci.lo > 0;

    // ---- Meta-Ensemble Stacking Optimization on OOS Walk Folds -----------
    const oosMetaDataset = [];
    const metaSourceNames = ['statistical', 'logistic', 'boosting-25', 'boosting-50', 'pattern-3'];
    for (let i = 0; i < yOOS.length; i++) {
        const probs = {
            statistical: contestants.statistical[i],
            logistic: applyCal('logistic', contestants.logistic)[i],
            'boosting-25': applyCal('boosting-25', contestants['boosting-25'])[i],
            'boosting-50': applyCal('boosting-50', contestants['boosting-50'])[i],
            'pattern-3': applyCal('pattern-3', contestants['pattern-3'])[i]
        };
        oosMetaDataset.push({ probs, outcome: yOOS[i] });
    }

    const ensembleFit = fitEnsembleWeights(oosMetaDataset, metaSourceNames);
    const learnedEnsembleWeights = {
        statistical: ensembleFit.weights.statistical || 1.0,
        feature_model: Math.max(1.0, Number((((ensembleFit.weights.logistic || 1.0) + (ensembleFit.weights['boosting-25'] || 1.0) + (ensembleFit.weights['boosting-50'] || 1.0)) / 3).toFixed(2))),
        hypothesis: 1.25
    };

    const report = {
        n: rows.length, nWalk: walkRows.length, nHoldout: holdoutRows.length,
        folds: segments.length, oosRows: idx.length, target,
        baseRate: Number((yWalk.reduce((a, b) => a + b, 0) / yWalk.length).toFixed(4)),
        standings: Object.fromEntries(Object.entries(standings).map(([k, v]) => [k, {
            brier: Number(v.brier.toFixed(5)),
            skill: v.skill === null ? null : Number(v.skill.toFixed(4)),
            ciLo: v.ci ? Number(v.ci.lo.toFixed(4)) : null,
            ciHi: v.ci ? Number(v.ci.hi.toFixed(4)) : null,
            calibrated: v.calibrated,
            adjustedPValue: v.adjustedPValue,
            significantFwer: v.significantFwer,
            bootstrapMethod: 'moving_block'
        }])),
        metaEnsemble: {
            weights: ensembleFit.weights,
            brierOOS: ensembleFit.brier,
            baselineBrier: ensembleFit.baselineBrier,
            learnedBrainWeights: learnedEnsembleWeights
        },
        winner: winnerName, walkQualified
    };

    if (!walkQualified) {
        return { verdict: 'NO_SIGNAL', winner: null, report };
    }

    // ---- Final untouched holdout: re-fit the winner on the whole walk zone -
    const Xwalk = buildMatrix(walkRows, names);
    const walkMeans = columnMeans(Xwalk);
    const Xw = buildMatrix(walkRows, names, walkMeans);
    const Xh = buildMatrix(holdoutRows, names, walkMeans);
    const yHold = holdoutRows.map((r) => (r.won ? 1 : 0));
    const walkBase = yWalk.reduce((a, b) => a + b, 0) / yWalk.length;

    let holdModel = null;       // serializable if DEPLOY
    let holdPreds = null;
    if (winnerName === 'logistic' || winnerName.startsWith('boosting')) {
        const fit = fitContestant(winnerName, Xw, yWalk, cols);
        if (!fit) return { verdict: 'NO_SIGNAL', winner: null, report };
        const raw = Xh.map((row) => fit.predict(row));
        holdPreds = calibrators[winnerName] ? raw.map(calibrators[winnerName].calibrate) : raw;
        const jsonFn = winnerName === 'logistic' ? logisticToJson : boostingToJson;
        holdModel = { json: jsonFn(fit, cols, names, {}, calibrators[winnerName]), fit };
    } else { // pattern-3
        const pmap = buildPatternMap(walkRows, PATTERN_WINDOW);
        holdPreds = holdoutRows.map((r) => patternPredict(pmap, r, walkBase, PATTERN_WINDOW));
        if (calibrators['pattern-3']) holdPreds = holdPreds.map(calibrators['pattern-3'].calibrate);
        holdModel = { json: patternModelToJson({ window: PATTERN_WINDOW, base: walkBase, map: pmap }, names, {}), fit: null };
    }

    // Persistence nulls on the holdout (strictly online continuation).
    const holdNullBase = expandingMeanNullPreds(yWalk, yHold, 1 / Number(target));
    const holdNullRecent = recentWindowNullPreds(yWalk, yHold, RECENT_NULL_WINDOW);
    const bestNullHold = Math.min(brierScore(holdNullBase, yHold), brierScore(holdNullRecent, yHold));
    const holdBrier = brierScore(holdPreds, yHold);
    const holdSkill = brierSkill(holdBrier, bestNullHold);
    const holdCi = bootstrapSkillCi(holdPreds, [holdNullBase, holdNullRecent], yHold, { iters: 600, rng: makeRng() });

    // Economic gates on the calibrated holdout predictions.
    const breakEven = 1 / target;
    const entryProb = breakEven + ENTRY_MARGIN;
    const entries = [];
    for (let i = 0; i < holdoutRows.length; i++) if (holdPreds[i] >= entryProb) entries.push(yHold[i]);
    const entryHits = entries.reduce((s, v) => s + v, 0);
    const entryRate = entries.length > 0 ? entryHits / entries.length : null;
    const evPerBet = entryRate === null ? null : entryRate * target - 1;
    const pEntry = entries.length > 0 ? hitRatePValue(entryHits, entries.length, breakEven) : 1;

    Object.assign(report, {
        holdout: {
            brier: Number(holdBrier.toFixed(5)),
            bestNullBrier: Number(bestNullHold.toFixed(5)),
            skill: holdSkill === null ? null : Number(holdSkill.toFixed(4)),
            ciLo: holdCi ? Number(holdCi.lo.toFixed(4)) : null,
            ciHi: holdCi ? Number(holdCi.hi.toFixed(4)) : null,
            entries: entries.length,
            entryHitRate: entryRate === null ? null : Number(entryRate.toFixed(4)),
            entryPValue: Number(pEntry.toFixed(4)),
            evPerBet: evPerBet === null ? null : Number(evPerBet.toFixed(4)),
            breakEven: Number(breakEven.toFixed(4))
        }
    });

    const deploy = holdCi && holdCi.lo > 0 &&
        entries.length >= 30 && pEntry < 0.05 &&
        Number.isFinite(evPerBet) && evPerBet > 0;

    return {
        verdict: deploy ? 'DEPLOY' : 'NO_SIGNAL',
        winner: deploy ? winnerName : null,
        report,
        deployModel: deploy ? holdModel : null,
        calibrator: deploy ? calibrators[winnerName] : null
    };
}

function runSite(siteId, opts = {}) {
    const file = path.join(config.DATA_DIR, `predictions-${String(siteId).replace(/[^a-z0-9._-]/gi, '_')}.jsonl`);
    if (!fs.existsSync(file)) return { site: siteId, error: `no prediction log (${path.basename(file)})` };
    const records = new PredictionLogger(file).readAll();
    const all = rowsForSite(records, siteId);
    if (all.length < 100) return { site: siteId, error: `only ${all.length} feature rows — need at least 100` };

    // Condition on the dominant target — never pool different targets.
    const byTarget = new Map();
    for (const r of all) {
        const key = Number(r.target).toFixed(2);
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key).push(r);
    }
    const targets = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length);
    const [domTarget, rows] = targets[0];

    const result = runTournament(rows, opts);
    const summary = {
        site: siteId,
        dominantTarget: Number(domTarget),
        droppedTargets: targets.slice(1).map(([t, rs]) => ({ target: Number(t), rows: rs.length })),
        source: 'tournament',
        ...result.report,
        verdict: result.verdict,
        winner: result.winner,
        reason: result.verdict === 'DEPLOY'
            ? `tournament winner "${result.winner}" beat the best persistence null out-of-sample with positive economic value`
            : result.verdict === 'NO_SIGNAL'
                ? 'no contestant cleared the out-of-sample gates — the live Brain stays discipline-only'
                : `insufficient out-of-sample data for a fair tournament`
    };

    writeTournamentVerdict(config.DATA_DIR, siteId, summary);

    if (result.verdict === 'DEPLOY' && result.deployModel) {
        const trainedAt = new Date().toISOString();
        const trainingEndTs = rows[rows.length - 1].ts || null;
        const meta = {
            site: siteId, target: summary.target, winner: result.winner,
            brierSkill: summary.holdout ? summary.holdout.skill : null,
            trained: trainedAt, trainingEndTs, rowsAtTraining: all.length,
            featureVersion: FEATURE_VERSION,
            ensembleWeights: summary.metaEnsemble ? summary.metaEnsemble.learnedBrainWeights : {}
        };
        const json = { ...result.deployModel.json, meta: { ...result.deployModel.json.meta, ...meta } };
        saveFeatureModel(config.DATA_DIR, siteId, json);
        writeModelVerdict(config.DATA_DIR, siteId, {
            ...summary, target: summary.dominantTarget,
            trainedAt, trainingEndTs, rowsAtTraining: all.length, featureVersion: FEATURE_VERSION,
            brierSkill: summary.holdout ? summary.holdout.skill : null,
            entryHitRate: summary.holdout ? summary.holdout.entryHitRate : null,
            evPerBet: summary.holdout ? summary.holdout.evPerBet : null,
            ensembleWeights: summary.metaEnsemble ? summary.metaEnsemble.learnedBrainWeights : {},
            n: summary.n, nHoldout: summary.nHoldout
        });
    } else {
        // Critical fix (review #10): when the tournament produces NO_SIGNAL
        // or INSUFFICIENT_DATA, it must immediately retire any old deployed
        // feature model and update model-verdict-<site>.json so the live
        // Brain falls back to discipline-only right away.
        retireFeatureModel(config.DATA_DIR, siteId);
        writeModelVerdict(config.DATA_DIR, siteId, {
            site: siteId,
            target: summary.dominantTarget,
            verdict: result.verdict,
            winner: null,
            source: 'tournament',
            reason: summary.reason,
            rowsAtTraining: all.length,
            featureVersion: FEATURE_VERSION,
            n: summary.n,
            nHoldout: summary.nHoldout,
            ts: Date.now()
        });
    }
    return summary;
}

function main() {
    const args = process.argv.slice(2);
    const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
    const files = fs.readdirSync(config.DATA_DIR).filter((f) => /^predictions-.*\.jsonl$/.test(f));
    const sites = files.map((f) => f.replace(/^predictions-/, '').replace(/\.jsonl$/, ''))
        .filter((s) => !siteArg || s === siteArg);
    if (sites.length === 0) {
        console.log(siteArg ? `No prediction log for site "${siteArg}" in ${config.DATA_DIR}.`
            : `No prediction logs found in ${config.DATA_DIR} — run the bot first.`);
        process.exit(1);
    }
    console.log('=====================================================');
    console.log(' MODEL TOURNAMENT (selector layer, strict no-peek)');
    console.log('=====================================================');
    for (const site of sites) {
        const r = runSite(site);
        console.log(`\n[${r.site}]`);
        if (r.error) { console.log(`  skipped: ${r.error}`); continue; }
        console.log(`  rows: ${r.n} (walk ${r.nWalk} / untouched holdout ${r.nHoldout}) @ target ${r.target}x, ${r.folds} folds` +
            (r.droppedTargets.length ? ` — other targets excluded: ${r.droppedTargets.map((d) => `${d.target}x(${d.rows})`).join(', ')}` : ''));
        if (r.standings) {
            console.log('  walk-forward standings (Brier skill vs best persistence null):');
            for (const [name, s] of Object.entries(r.standings)) {
                console.log(`    ${name.padEnd(11)} skill ${String(s.skill).padEnd(8)} CI [${s.ciLo}, ${s.ciHi}]${s.calibrated ? '  (calibrated)' : ''}`);
            }
            console.log(`  selector: winner "${r.winner}" ${r.walkQualified ? 'qualified for the holdout' : 'did NOT qualify (CI includes zero)'}`);
        }
        if (r.holdout) {
            console.log(`  final holdout: skill ${r.holdout.skill} CI [${r.holdout.ciLo}, ${r.holdout.ciHi}] | ` +
                `entries ${r.holdout.entries} hit ${r.holdout.entryHitRate} p=${r.holdout.entryPValue} EV/bet=${r.holdout.evPerBet}`);
        }
        console.log(`  VERDICT: ${r.verdict}` +
            (r.verdict === 'DEPLOY'
                ? ` — "${r.winner}" deployed to the live Brain (it beat every persistence null with economic value)`
                : r.verdict === 'NO_SIGNAL'
                    ? ' — no contestant proved out-of-sample edge; the live Brain stays discipline-only. A CORRECT answer.'
                    : ' — need more out-of-sample data for a fair tournament.'));
    }
}

if (require.main === module) main();

module.exports = { runTournament, runSite, buildPatternMap, patternPredict, PATTERN_WINDOW };
