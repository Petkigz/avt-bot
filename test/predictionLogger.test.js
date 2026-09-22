'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PredictionLogger = require('../game/predictionLogger');

test('prediction + outcome round-trip through JSONL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-pl-'));
    const log = new PredictionLogger(path.join(dir, 'predictions.jsonl'));
    assert.equal(log.logPrediction({ site: 'betpawa.ug', target: 1.3, prob: 0.72, allowed: true }), true);
    assert.equal(log.logOutcome({ site: 'betpawa.ug', target: 1.3, prob: 0.72, crash: 1.55, won: true }), true);

    const all = log.readAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].kind, 'predict');
    assert.equal(all[1].kind, 'settle');
    assert.equal(all[1].won, true);
    assert.ok(all[0].ts > 0);

    const settled = log.settledPairs();
    assert.equal(settled.length, 1);
    assert.equal(settled[0].prob, 0.72);
});

test('append-only across instances and tolerant of corrupt lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-pl-'));
    const file = path.join(dir, 'p.jsonl');
    new PredictionLogger(file).logPrediction({ prob: 0.5 });
    fs.appendFileSync(file, 'NOT JSON GARBAGE\n');
    const second = new PredictionLogger(file);
    second.logOutcome({ prob: 0.5, won: false });
    const all = second.readAll();
    assert.equal(all.length, 2); // garbage line skipped
    assert.equal(all[0].kind, 'predict');
    assert.equal(all[1].kind, 'settle');
});

test('missing file reads as empty', () => {
    const log = new PredictionLogger(path.join(os.tmpdir(), 'does-not-exist-x.jsonl'));
    assert.deepEqual(log.readAll(), []);
    assert.deepEqual(log.settledPairs(), []);
});
