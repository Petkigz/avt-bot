'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runTournament } = require('../scripts/model-tournament');
const { fitBoosting, boostingToJson, patternModelToJson, modelFromJson } = require('../game/modelLayer');

function makeRng(seed = 11) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// Synthetic feature rows: `signal` injects a genuinely learnable feature
// (win probability rises linearly with the signal feature), otherwise all
// features are noise and the outcome is a fixed base rate.
function syntheticRows(n, seed, signal) {
    const rng = makeRng(seed);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const s = rng();
        const feats = { signal: signal ? 2.5 * s - 0.75 : rng(), noise: rng() };
        for (let k = 1; k <= 3; k++) feats[`last_${k}`] = 1 + rng() * 2;
        rows.push({
            target: 1.3,
            won: rng() < (signal ? 0.2 + 0.75 * s : 0.74),
            features: feats,
            ts: 1700000000000 + i * 12000
        });
    }
    return rows;
}

test('tournament DEPLOYs the strongest contestant when a real signal exists', () => {
    const { verdict, winner, report, deployModel } = runTournament(syntheticRows(1500, 9, true));
    assert.strictEqual(verdict, 'DEPLOY');
    assert.ok(['logistic', 'boosting-25', 'boosting-50', 'pattern-3'].includes(winner), `unexpected winner ${winner}`);
    // The selector must rank by out-of-sample Brier skill with a positive CI.
    const stand = report.standings[winner];
    assert.ok(stand.skill > 0, 'winner skill must be positive');
    assert.ok(stand.ciLo > 0, 'winner CI lower bound must be positive');
    // Deploy payload must be loadable through the universal model dispatcher
    // (same path the live Brain uses) and keep predicting.
    assert.ok(deployModel && deployModel.json, 'deploy payload present');
    const restored = modelFromJson(deployModel.json);
    const p = restored.predict({ signal: 1.5, noise: 0.5, last_1: 2, last_2: 2, last_3: 2 });
    assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `deploy model predicts in [0,1], got ${p}`);
});

test('tournament returns NO_SIGNAL on pure noise — nobody beats the null', () => {
    const { verdict, winner } = runTournament(syntheticRows(1200, 17, false));
    assert.strictEqual(verdict, 'NO_SIGNAL');
    assert.strictEqual(winner, null);
});

test('tournament refuses to run on too few rows', () => {
    const { verdict } = runTournament(syntheticRows(50, 3, true));
    assert.strictEqual(verdict, 'INSUFFICIENT_DATA');
});

test('boosting JSON round-trips through modelFromJson and keeps predicting', () => {
    const rng = makeRng(23);
    const X = [], y = [];
    for (let i = 0; i < 400; i++) {
        const s = rng();
        X.push([s, rng()]);
        y.push(rng() < 0.2 + 0.7 * s ? 1 : 0);
    }
    const colIdx = [0, 1];
    const names = ['signal', 'noise'];
    const model = fitBoosting(X, y, colIdx, { trees: 60 });
    assert.ok(model, 'boosting should fit 400 rows');
    const json = boostingToJson(model, colIdx, names, { kind: 'boosting-v1' });
    const restored = modelFromJson(json);
    assert.strictEqual(restored.meta.kind, 'boosting-v1');
    const p = restored.predict({ signal: 0.9, noise: 0.5 });
    assert.ok(Number.isFinite(p) && p > 0.5, `strong signal point should predict high, got ${p}`);
    // Missing features impute to training means — never NaN.
    const pMiss = restored.predict({});
    assert.ok(Number.isFinite(pMiss), `imputed prediction must be finite, got ${pMiss}`);
});

test('pattern model JSON round-trips and falls back to the base rate on unseen windows', () => {
    // Window symbols: v<1.5 -> L, <2.5 -> M, else H. Keys are oldest->newest.
    const map = { LMH: { wins: 7, used: 10 } };
    const json = patternModelToJson({ map, base: 0.4, window: 3 }, ['last_3', 'last_2', 'last_1'], { kind: 'pattern-v1' });
    const restored = modelFromJson(json);
    assert.strictEqual(restored.meta.kind, 'pattern-v1');
    // Unseen window -> exactly the base rate (never NaN, never fake confidence).
    const base = restored.predict({ last_3: 9, last_2: 9, last_1: 9 }); // HHH
    assert.ok(Math.abs(base - 0.4) < 1e-9, `fallback should be the base rate, got ${base}`);
    // Low-support window (used < 8) also falls back.
    const weak = { HHH: { wins: 9, used: 3 } };
    const jsonWeak = patternModelToJson({ map: weak, base: 0.4, window: 3 }, ['last_3', 'last_2', 'last_1'], {});
    const pWeak = modelFromJson(jsonWeak).predict({ last_3: 9, last_2: 9, last_1: 9 });
    assert.ok(Math.abs(pWeak - 0.4) < 1e-9, `low-support window must fall back to base, got ${pWeak}`);
    // Seen winning window -> wins/used, above base rate.
    const seen = restored.predict({ last_3: 1.0, last_2: 2.0, last_1: 3.0 }); // LMH
    assert.ok(Math.abs(seen - 0.7) < 1e-9, `seen window should be wins/used=0.7, got ${seen}`);
    // Missing features -> base rate, never NaN.
    assert.ok(Math.abs(restored.predict({}) - 0.4) < 1e-9);
});
