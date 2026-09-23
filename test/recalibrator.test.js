const test = require('node:test');
const assert = require('node:assert');
const Recalibrator = require('../game/recalibrator');

test('pass-through until enough predictions have settled', () => {
    const r = new Recalibrator({ minSettled: 50 });
    for (let i = 0; i < 40; i++) r.update(0.7, i % 4 === 0 ? 1 : 0);
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.adjust(0.9), 0.9); // untouched
});

test('corrects an over-confident predictor toward reality', () => {
    // The "model" claims 0.9 on every round but reality only wins 40% of the
    // time. After enough evidence, adjust(0.9) must come DOWN toward 0.4 —
    // the engine learning its own over-confidence.
    const r = new Recalibrator({ minSettled: 100 });
    for (let i = 0; i < 400; i++) r.update(0.9, i % 10 < 4 ? 1 : 0);
    assert.strictEqual(r.ready, true);
    const corrected = r.adjust(0.9);
    assert.ok(corrected < 0.6, `expected correction well below the claimed 0.9, got ${corrected}`);
    assert.ok(Math.abs(corrected - 0.4) < 0.12, `expected ~0.4 base rate, got ${corrected}`);
});

test('corrected probabilities improve the Brier score (audit trail)', () => {
    // Seeded stream: true win probability 0.35, but the model over-claims.
    const r = new Recalibrator({ minSettled: 80, bins: 5 });
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    // Warm the map
    for (let i = 0; i < 300; i++) r.update(0.85, rand() < 0.35 ? 1 : 0);
    // Now measure: feed pending corrections, then outcomes, over 400 rounds
    let wins = 0;
    for (let i = 0; i < 400; i++) {
        const y = rand() < 0.35 ? 1 : 0;
        wins += y;
        r.notePending(0.85);
        r.update(0.85, y);
    }
    const s = r.snapshot();
    assert.ok(s.auditRounds >= 350);
    assert.ok(s.brierAdjusted < s.brierRaw,
        `corrected Brier ${s.brierAdjusted} should beat raw ${s.brierRaw}`);
    assert.strictEqual(s.helping, true);
});

test('persists and reloads without losing the learned map', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recal-')), 'r.json');
    const a = new Recalibrator({ file, minSettled: 50 });
    for (let i = 0; i < 200; i++) a.update(0.9, i % 5 < 2 ? 1 : 0);
    a.save();
    const b = new Recalibrator({ file, minSettled: 50 });
    b.load();
    assert.strictEqual(b.total, 200);
    assert.ok(Math.abs(b.adjust(0.9) - a.adjust(0.9)) < 1e-9);
});
