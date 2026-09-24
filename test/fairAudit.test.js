'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { auditDistribution, binomialPValue } = require('../scripts/fair-audit');

function makeRng(seed = 5) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// Fair crash sampler: survival P(X >= x) = (1 - r)/x, instant-bust mass r.
// U ~ Uniform(0,1); X = (1-r)/U, but if U > 1-r that maps below 1 -> bust at 1.
function fairStream(n, seed, r) {
    const u = makeRng(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        const U = u();
        out.push(U > 1 - r ? 1 : (1 - r) / U);
    }
    return out;
}

test('binomialPValue: exact match gives p≈1, big deviation gives p≈0', () => {
    const n = 1000;
    const p = 0.25;
    assert.ok(binomialPValue(Math.round(n * p), n, p) > 0.5, 'on-target should be high p');
    assert.ok(binomialPValue(Math.round(n * p) + 200, n, p) < 0.001, 'far off should be tiny p');
});

test('a genuinely fair stream audits as CONSISTENT_WITH_FAIR', () => {
    const r = auditDistribution(fairStream(5000, 5, 0.03));
    assert.strictEqual(r.verdict, 'CONSISTENT_WITH_FAIR');
    assert.strictEqual(r.flagged.length, 0);
    // Edge estimate should land near the generator's 3%.
    assert.ok(Math.abs(r.estimatedHouseEdge - 0.03) < 0.02, `edge ${r.estimatedHouseEdge} should be near 0.03`);
});

test('a rigged low-crash stream is FLAGGED with LOW-SKEW', () => {
    // Force a chunk of mid rounds to crash low (the classic "eats your 1.3x").
    const rigged = fairStream(5000, 7, 0.03).map((x, i) =>
        (i % 5 === 0 && x >= 1.3 && x < 2) ? 1.1 : x);
    const r = auditDistribution(rigged);
    assert.strictEqual(r.verdict, 'FLAGGED');
    assert.ok(r.flagged.some((f) => f.startsWith('LOW-SKEW')), 'should flag a low-crash skew');
});

test('too few rounds returns INSUFFICIENT_DATA, never a verdict', () => {
    const r = auditDistribution(fairStream(50, 3, 0.03));
    assert.strictEqual(r.verdict, 'INSUFFICIENT_DATA');
});

test('a stream with an impossible instant-bust mass is flagged', () => {
    // 40% instant busts is far outside any sane operator band.
    const weird = fairStream(3000, 9, 0.03).map((x, i) => (i % 10 < 4 ? 1 : Math.max(1.02, x)));
    const r = auditDistribution(weird);
    assert.strictEqual(r.verdict, 'FLAGGED');
    assert.ok(r.flagged.some((f) => f.includes('instant-bust')), 'should flag implausible edge');
});

test('Bonferroni: the real betpawa.ug case is WATCHED, not flagged', () => {
    // Regression from the live audit of 2026-09-24: 2605 rounds, 5.07%
    // instant-bust mass, and a tail running slightly HOT at every threshold
    // (1.3x: 75.4% observed vs 73.0% fair, nominal p=0.0074). Six thresholds
    // tested on the SAME rounds means that deviation does NOT survive
    // family-wise correction — flagging it would false-flag fair streams ~6%
    // of the time. The honest read: CONSISTENT_WITH_FAIR, kept on watch.
    const n = 2605;
    const S = { t13: 1964, t15: 1696, t2: 1287, t3: 852, t5: 518, t10: 274 }; // observed survival counts
    const instant = 132;
    const vals = [];
    for (let i = 0; i < instant; i++) vals.push(1.0);
    for (let i = 0; i < (n - instant - S.t13); i++) vals.push(1.15);
    for (let i = 0; i < (S.t13 - S.t15); i++) vals.push(1.4);
    for (let i = 0; i < (S.t15 - S.t2); i++) vals.push(1.7);
    for (let i = 0; i < (S.t2 - S.t3); i++) vals.push(2.5);
    for (let i = 0; i < (S.t3 - S.t5); i++) vals.push(4.0);
    for (let i = 0; i < (S.t5 - S.t10); i++) vals.push(7.0);
    for (let i = 0; i < S.t10; i++) vals.push(15.0);
    const r = auditDistribution(vals);
    assert.strictEqual(r.verdict, 'CONSISTENT_WITH_FAIR',
        `nominal-only drift must not flag, got ${r.verdict}: ${r.flagged}`);
    assert.strictEqual(r.flagged.length, 0);
    // The deviation must still be VISIBLE as a watch item — never buried.
    assert.ok(r.watch.some((w) => w.includes('1.3x')), 'the hot 1.3x bin stays on watch');
});
