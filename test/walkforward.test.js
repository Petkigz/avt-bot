'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWalkForward, generateSynthetic } = require('../scripts/walk-forward');

test('walk-forward reports no signal on honest synthetic RNG', () => {
    const values = generateSynthetic(3000, 0.03, 1234);
    const report = runWalkForward(values, { target: 1.3, trainMin: 300, testSize: 100 });
    assert.ok(!report.error, report.error);
    assert.ok(report.folds >= 20);
    assert.ok(report.oosBaseRate > 0.6 && report.oosBaseRate < 0.9);
    for (const [name, r] of Object.entries(report.results)) {
        assert.ok(name.length > 0);
        assert.ok(Number.isFinite(r.brier));
        // On a fair RNG no estimator may claim significant out-of-sample lift.
        // (A 5% false-positive rate exists; with 4 variants and seed 1234
        // this is deterministic — the seeded RNG never trips it.)
        assert.equal(r.significant, false, `${name} claimed signal on fair RNG`);
    }
    assert.equal(report.signalDetected, false);
    assert.match(report.verdict, /NO PREDICTIVE SIGNAL/);
});

test('walk-forward refuses too-short histories', () => {
    const report = runWalkForward([1.2, 1.5, 2.0], { target: 1.3 });
    assert.match(report.error, /need at least/);
});

test('a genuinely rigged stream is detected out-of-sample', () => {
    // Persistent regimes: 150-round blocks alternating all-1.1 / all-5.0.
    // After ~50 rounds inside a block the recent-window estimator sees it,
    // so it bets through the rest of that block (2 winning test folds per
    // 1 losing one) — a real, exploitable, out-of-sample structure.
    const values = [];
    for (let b = 0; b < 17; b++) {
        const v = b % 2 === 0 ? 1.1 : 5.0;
        for (let i = 0; i < 150; i++) values.push(v);
    }
    const report = runWalkForward(values, { target: 1.3, trainMin: 300, testSize: 50, margin: 0.02 });
    assert.ok(!report.error, report.error);
    assert.equal(report.signalDetected, true, 'rigged stream must be detected');
    assert.ok(report.results.recent.significant || report.results.recency.significant,
        'the lag-aware estimators should be the ones catching the regime');
});

test('writeVerdict/readVerdict persist a verdict for the live engine', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { writeVerdict, readVerdict } = require('../scripts/walk-forward');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-wf-'));
    const report = {
        rounds: 1200, target: 1.3, signalDetected: false,
        verdict: 'NO PREDICTIVE SIGNAL DETECTED — gates run discipline-only.',
        results: { baseline: { bets: 0 } }
    };
    const file = writeVerdict(dir, 'betpawa.ug', report);
    assert.ok(file && fs.existsSync(file));
    const back = readVerdict(dir, 'betpawa.ug');
    assert.strictEqual(back.signalDetected, false);
    assert.strictEqual(back.rounds, 1200);
    assert.match(back.verdict, /NO PREDICTIVE SIGNAL/);
    assert.equal(readVerdict(dir, 'nobody.example'), null);
});

test('holmBonferroni controls family-wise error across variants', () => {
    const { holmBonferroni } = require('../scripts/walk-forward');
    // One clearly significant p survives alone
    assert.deepEqual(holmBonferroni([0.001, null, null], 0.05), [true, false, false]);
    // Two borderline p-values: 0.03 passes rank-1 threshold (0.05/2=0.025)?
    // No: 0.03 > 0.025 -> step-down stops, BOTH rejected. That is the point.
    assert.deepEqual(holmBonferroni([0.03, 0.03], 0.05), [false, false]);
    // 0.02 <= 0.025 passes rank 1; 0.04 <= 0.05 passes rank 2
    assert.deepEqual(holmBonferroni([0.02, 0.04], 0.05), [true, true]);
    // Nulls never pass
    assert.deepEqual(holmBonferroni([null, null], 0.05), [false, false]);
});

test('walk-forward report documents the multiple-testing correction', () => {
    const { runWalkForward, generateSynthetic } = require('../scripts/walk-forward');
    const report = runWalkForward(generateSynthetic(1200, 0.03, 7), { target: 1.3 });
    assert.match(report.correction, /holm-bonferroni/);
    assert.strictEqual(report.signalDetected, false);
});
