'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pairRecords, analyzeSite, reliability, pearson, MIN_PAIRS } = require('../scripts/error-analysis');

function records(pairs) {
    // pairs: [{site, target, prob, won, crash, features?, tier?}]
    const out = [];
    for (const p of pairs) {
        out.push({ kind: 'predict', ts: 1, site: p.site, target: p.target, prob: p.prob, tier: p.tier || 'MICRO', features: p.features });
        out.push({ kind: 'settle', ts: 2, site: p.site, target: p.target, prob: p.prob, crash: p.crash ?? (p.won ? 2 : 1.1), won: p.won });
    }
    return out;
}

test('pairRecords joins predict->settle per site; orphan settles keep their own fields', () => {
    const recs = records([
        { site: 'a', target: 1.3, prob: 0.7, won: true },
        { site: 'b', target: 1.3, prob: 0.6, won: false }
    ]);
    // Orphan settle (no open predict): still usable — it carries prob + outcome.
    recs.push({ kind: 'settle', ts: 3, site: 'a', target: 1.3, prob: 0.5, crash: 1.1, won: false });
    // A predict with an out-of-range probability that never settles: dropped.
    recs.push({ kind: 'predict', ts: 4, site: 'a', target: 1.3, prob: 1.5 });
    const pairs = pairRecords(recs);
    assert.strictEqual(pairs.length, 3);
    const orphan = pairs.find((p) => p.prob === 0.5);
    assert.ok(orphan, 'orphan settle must be kept');
    assert.strictEqual(orphan.features, null, 'orphan settle has no feature snapshot');
    // The paired site-a row keeps its predict-side enrichment.
    const enriched = pairs.find((p) => p.site === 'a' && p.prob === 0.7);
    assert.strictEqual(enriched.tier, 'MICRO');
});

test('analyzeSite: a perfectly matched model gets zero Brier skill and zero ECE', () => {
    const pairs = [];
    for (let i = 0; i < 120; i++) pairs.push({ site: 's', target: 1.3, prob: 0.75, won: i < 90 });
    const report = analyzeSite('s', records(pairs));
    assert.strictEqual(report.pairs, 120);
    assert.strictEqual(report.baseRate, 0.75);
    assert.strictEqual(report.brierSkill, 0);
    assert.strictEqual(report.ece, 0);
    assert.strictEqual(report.calibrationDirection, 'well-centered');
    assert.match(report.verdict, /NO CALIBRATION EDGE/);
});

test('analyzeSite: an over-confident model is flagged with negative skill', () => {
    const pairs = [];
    for (let i = 0; i < 100; i++) pairs.push({ site: 's', target: 1.3, prob: 0.9, won: i < 60 });
    const report = analyzeSite('s', records(pairs));
    assert.ok(report.brierSkill < 0, `skill ${report.brierSkill} should be negative`);
    assert.strictEqual(report.calibrationDirection, 'over-confident (wins less than predicted)');
    assert.ok(report.ece > 0.2);
});

test('analyzeSite: below MIN_PAIRS reports insufficient data', () => {
    const pairs = [];
    for (let i = 0; i < MIN_PAIRS - 1; i++) pairs.push({ site: 's', target: 1.3, prob: 0.7, won: i % 2 === 0 });
    const report = analyzeSite('s', records(pairs));
    assert.match(report.verdict, /INSUFFICIENT DATA/);
});

test('feature scan flags a genuinely predictive feature and ignores constants', () => {
    const pairs = [];
    for (let i = 0; i < 150; i++) {
        const won = i % 2 === 0;
        pairs.push({
            site: 's', target: 1.3, prob: 0.7, won,
            features: { hot: won ? 10 : 1, constant: 5 }
        });
    }
    const report = analyzeSite('s', records(pairs));
    assert.strictEqual(report.features.skipped, false);
    const names = report.features.rows.map((r) => r.feature);
    assert.ok(names.includes('hot'));
    assert.ok(!names.includes('constant'), 'zero-variance feature must be excluded');
    const hot = report.features.rows.find((r) => r.feature === 'hot');
    assert.ok(hot.significant, `hot feature must survive Holm (p=${hot.p})`);
});

test('reliability bins report realized-vs-predicted gaps', () => {
    const pairs = [];
    for (let i = 0; i < 100; i++) pairs.push({ prob: 0.35, won: i < 35 });
    const { table, ece } = reliability(pairs);
    const bin = table.find((b) => b.n > 0);
    assert.ok(bin);
    assert.ok(Math.abs(bin.realized - 0.35) < 0.05);
    assert.ok(ece < 0.05);
});

test('pearson returns null on degenerate inputs', () => {
    assert.strictEqual(pearson([1, 2], [0, 1]).r, null); // n < 3
    assert.strictEqual(pearson([2, 2, 2], [0, 1, 0]).r, null); // zero variance
});
