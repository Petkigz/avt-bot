const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { trainAndEvaluate, rowsForSite } = require('../scripts/train-model');
const { logisticFromJson } = require('../game/modelLayer');

function makeRng(seed = 9) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// Rows with a REAL planted signal: feature `signal` determines the true hit
// probability (won = U < 0.2 + 0.75*signal). A model that reads the feature
// genuinely beats the base-rate null and shows positive EV on its entries.
// The signal is steep because a 21-feature fit pays L2 shrinkage on the noise
// columns and needs a strong gradient to survive it.
function signalRows(n, seed) {
    const rng = makeRng(seed);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const s = rng();
        rows.push({
            target: 1.3,
            won: rng() < 0.2 + 0.75 * s,
            features: { signal: 2.5 * s - 0.75, noise: rng() }
        });
    }
    return rows;
}

// Rows with NO signal: outcomes are a coin flip independent of the feature.
function noiseRows(n, seed, base = 0.74) {
    const rng = makeRng(seed);
    const rows = [];
    for (let i = 0; i < n; i++) {
        rows.push({
            target: 1.3,
            won: rng() < base,
            features: { signal: rng(), noise: rng() }
        });
    }
    return rows;
}

test('trainAndEvaluate: planted signal earns a DEPLOY verdict', () => {
    const r = trainAndEvaluate(signalRows(1500, 9));
    assert.strictEqual(r.error, undefined);
    assert.ok(r.nHoldout >= 150, `holdout must meet the minimum (got ${r.nHoldout})`);
    assert.ok(r.nCalib >= 100, `calibration segment must be reserved (got ${r.nCalib})`);
    // Calibration is ALWAYS attempted on the reserved segment; whether the
    // Platt map is adopted depends on whether it actually improves calibration
    // (see the do-no-harm test below). Either way the choice is documented.
    assert.ok(typeof r.calibNote === 'string' && r.calibNote.length > 0, 'calibration decision must be documented');
    assert.ok(r.brierSkill > 0, `skill must be positive (got ${r.brierSkill})`);
    assert.ok(r.bootstrapCi.lo > 0, `CI lower bound must clear zero (got ${r.bootstrapCi.lo})`);
    assert.ok(r.entries >= 30, `model must approve enough entries (got ${r.entries})`);
    assert.ok(r.entryPValue < 0.05, `entry hit rate must be significant (p=${r.entryPValue})`);
    assert.ok(r.evPerBet > 0, `approved entries must have positive EV (got ${r.evPerBet})`);
    assert.ok(r.bestNull === 'base-rate' || r.bestNull === 'recent-window');
    assert.strictEqual(r.verdict, 'DEPLOY');
});

test('trainAndEvaluate: calibration does no harm — a miscalibrating Platt fit is rejected', () => {
    // On the clean planted-signal stream the logistic model is already well
    // calibrated, so a noisy Platt fit can only make it WORSE. The pipeline
    // must detect that on the calibration segment and keep the identity map
    // instead of shipping a distorted probability.
    const r = trainAndEvaluate(signalRows(1500, 9));
    if (r.calibrated) {
        // If this seed happens to produce a helpful Platt, it must have
        // genuinely improved calibration in-sample — still fine.
        assert.match(r.calibNote, /Platt adopted/);
    } else {
        assert.match(r.calibNote, /identity/, 'harmful calibrator must be rejected in favour of identity');
    }
    // Whatever the calibration choice, the deployed probability must still be
    // able to clear the entry gate when the signal is real.
    assert.ok(r.entries > 0, 'calibration must not destroy a real signal');
});

test('trainAndEvaluate: pure noise earns NO_SIGNAL (first-class outcome)', () => {
    const r = trainAndEvaluate(noiseRows(900, 17));
    assert.strictEqual(r.verdict, 'NO_SIGNAL');
    // Either the skill CI includes zero or there are no profitable entries —
    // at least one gate must have refused deployment.
    const skillRefused = !r.bootstrapCi || r.bootstrapCi.lo <= 0;
    const entriesRefused = r.entries < 30 || r.entryPValue >= 0.05 || !(r.evPerBet > 0);
    assert.ok(skillRefused || entriesRefused, 'a NO_SIGNAL verdict must trace to a failed gate');
});

test('trainAndEvaluate: too little holdout data yields INSUFFICIENT_DATA', () => {
    const r = trainAndEvaluate(signalRows(300, 23)); // ~102 holdout rows < 150
    assert.strictEqual(r.verdict, 'INSUFFICIENT_DATA');
});

test('rowsForSite keeps only paired, feature-carrying rows of the site', () => {
    const records = [
        { kind: 'predict', site: 'a', target: 1.3, prob: 0.7, features: { f: 1 }, ts: 1 },
        { kind: 'settle', site: 'a', target: 1.3, prob: 0.7, crash: 2.0, won: true, ts: 2 },
        { kind: 'predict', site: 'b', target: 1.3, prob: 0.7, features: { f: 2 }, ts: 3 },
        { kind: 'settle', site: 'b', target: 1.3, prob: 0.7, crash: 1.1, won: false, ts: 4 },
        // site a predict without features -> settle pairs but is dropped later
        { kind: 'predict', site: 'a', target: 1.3, prob: 0.6, ts: 5 },
        { kind: 'settle', site: 'a', target: 1.3, prob: 0.6, crash: 1.1, won: false, ts: 6 }
    ];
    const rows = rowsForSite(records, 'a');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].won, true);
    assert.deepStrictEqual(rows[0].features, { f: 1 });
});

test('train-model CLI end-to-end: DEPLOY writes verdict + model, conditions on dominant target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainmodel-'));
    // 1200 signal rows at target 1.3 + 100 noise rows at target 2.0.
    const lines = [];
    const addPair = (target, s, won, ts) => {
        const prob = 0.2 + 0.75 * s;
        lines.push(JSON.stringify({ kind: 'predict', site: 'unit.test', target, prob, threshold: prob, allowed: true, tier: 'MICRO', regime: '', features: { signal: s, noise: 0.5 }, ts }));
        lines.push(JSON.stringify({ kind: 'settle', site: 'unit.test', target, prob, crash: won ? 1.31 : 1.05, won, ts: ts + 1 }));
    };
    const rng = makeRng(31);
    let ts = 1000;
    for (let i = 0; i < 1200; i++) {
        const s = rng();
        addPair(1.3, s, rng() < 0.2 + 0.75 * s, ts += 2);
    }
    for (let i = 0; i < 100; i++) {
        const s = rng();
        addPair(2.0, s, rng() < 0.37, ts += 2); // ~1/2 break-even noise
    }
    fs.writeFileSync(path.join(dir, 'predictions-unit.test.jsonl'), lines.join('\n') + '\n');

    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'train-model.js'), '--site', 'unit.test'], {
        env: { ...process.env, DATA_DIR: dir },
        encoding: 'utf8'
    });
    assert.match(out, /VERDICT: DEPLOY/);

    const verdict = JSON.parse(fs.readFileSync(path.join(dir, 'model-verdict-unit.test.json'), 'utf8'));
    assert.strictEqual(verdict.verdict, 'DEPLOY');
    assert.strictEqual(verdict.dominantTarget, 1.3);
    assert.deepStrictEqual(verdict.droppedTargets, [{ target: 2, rows: 100 }], 'non-dominant target must be excluded, not pooled');
    // Lifecycle metadata (review #8): staleness detection depends on these.
    assert.strictEqual(verdict.featureVersion, 1);
    assert.ok(Number.isFinite(verdict.rowsAtTraining), 'rowsAtTraining must be recorded');
    assert.ok(Number.isFinite(verdict.trainingEndTs), 'trainingEndTs must be recorded');
    assert.ok(verdict.trainedAt, 'trainedAt must be recorded');

    const modelJson = JSON.parse(fs.readFileSync(path.join(dir, 'feature-model-unit.test.json'), 'utf8'));
    assert.ok('platt' in modelJson, 'model file must carry the calibration decision (platt field present)');
    assert.strictEqual(modelJson.meta.target, 1.3, 'model must record the target it was trained for');
    assert.strictEqual(modelJson.meta.featureVersion, 1, 'model must record the feature schema version');
    const live = logisticFromJson(modelJson);
    assert.ok(live, 'deployed model must load');
    assert.ok(live.predict({ signal: 1 }) > live.predict({ signal: 0 }), 'deployed model must reproduce the signal');
    fs.rmSync(dir, { recursive: true, force: true });
}, { timeout: 120000 });

test('train-model CLI end-to-end: noise data writes a NO_SIGNAL verdict and NO model file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trainmodel-'));
    const lines = [];
    const rng = makeRng(53);
    let ts = 1000;
    for (let i = 0; i < 900; i++) {
        const prob = 0.74;
        const won = rng() < 0.74;
        lines.push(JSON.stringify({ kind: 'predict', site: 'noise.site', target: 1.3, prob, threshold: prob, allowed: true, tier: 'MICRO', regime: '', features: { signal: rng(), noise: rng() }, ts: ++ts }));
        lines.push(JSON.stringify({ kind: 'settle', site: 'noise.site', target: 1.3, prob, crash: won ? 1.5 : 1.1, won, ts: ++ts }));
    }
    fs.writeFileSync(path.join(dir, 'predictions-noise.site.jsonl'), lines.join('\n') + '\n');

    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'train-model.js'), '--site', 'noise.site'], {
        env: { ...process.env, DATA_DIR: dir },
        encoding: 'utf8'
    });
    assert.match(out, /VERDICT: NO_SIGNAL/);

    const verdict = JSON.parse(fs.readFileSync(path.join(dir, 'model-verdict-noise.site.json'), 'utf8'));
    assert.strictEqual(verdict.verdict, 'NO_SIGNAL');
    assert.ok(!fs.existsSync(path.join(dir, 'feature-model-noise.site.json')),
        'NO_SIGNAL must never write a model file');
    fs.rmSync(dir, { recursive: true, force: true });
}, { timeout: 120000 });
