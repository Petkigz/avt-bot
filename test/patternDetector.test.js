const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PatternDetector = require('../game/patternDetector');

function makeDetector(overrides = {}) {
    return new PatternDetector({
        lengths: [3],
        minSupport: 3,
        bins: [1.5, 2.5],
        targetMultiplier: 1.5,
        ...overrides
    });
}

test('symbolizes crashes into L/M/H bins', () => {
    const d = makeDetector();
    assert.strictEqual(d.symbol(1.2), 'L');
    assert.strictEqual(d.symbol(2.0), 'M');
    assert.strictEqual(d.symbol(7.5), 'H');
});

test('learns what follows a pattern and predicts with Laplace smoothing', () => {
    const d = makeDetector();
    // Feed "L L L -> high crash" four times
    for (let i = 0; i < 4; i++) {
        d.observe(1.1); d.observe(1.2); d.observe(1.3); d.observe(3.0);
    }
    // Stream now ends with ...3.0; rebuild a suffix of L L L manually for detect:
    d.stream = ['L', 'L', 'L'];
    const det = d.detect();
    assert.strictEqual(det.found, true);
    assert.strictEqual(det.pattern, 'LLL');
    assert.strictEqual(det.seen, 4);
    assert.strictEqual(det.probability, (4 + 1) / (4 + 2)); // all 4 followed by >= 1.5
});

test('patterns below minSupport are not trusted', () => {
    const d = makeDetector({ minSupport: 10 });
    d.observe(1.1); d.observe(1.2); d.observe(1.3); d.observe(3.0); // LLL seen once
    d.stream = ['L', 'L', 'L'];
    assert.strictEqual(d.detect().found, false);
});

test('prefers the longest supported pattern', () => {
    const d = makeDetector({ lengths: [5, 3], minSupport: 2 });
    // Build history where a 5-symbol pattern repeats with good outcomes
    const seq = [1.1, 1.2, 3.0, 1.3, 3.5]; // L L H L H
    for (let i = 0; i < 3; i++) seq.forEach((v) => d.observe(v));
    d.observe(1.1); d.observe(1.2); d.observe(3.0); d.observe(1.3); d.observe(3.5);
    const det = d.detect();
    assert.strictEqual(det.found, true);
    assert.strictEqual(det.length, 5);
});

test('a risky pattern is flagged', () => {
    const d = makeDetector({ minSupport: 3 });
    // L L L always followed by another low crash
    for (let i = 0; i < 5; i++) {
        d.observe(1.1); d.observe(1.2); d.observe(1.3); d.observe(1.05);
    }
    d.stream = ['L', 'L', 'L'];
    const det = d.detect();
    assert.strictEqual(det.found, true);
    assert.strictEqual(det.risky, true);
    assert.ok(det.probability < 0.45);
});

test('a pattern that keeps failing live use goes stale (benched)', () => {
    const d = makeDetector({ minSupport: 2, staleAfterFails: 3 });
    for (let i = 0; i < 4; i++) {
        d.observe(1.1); d.observe(1.2); d.observe(1.3); d.observe(3.0);
    }
    d.stream = ['L', 'L', 'L'];
    const det = d.detect();
    assert.strictEqual(det.found, true);

    d.recordUsageOutcome(det, false);
    d.recordUsageOutcome(det, false);
    d.recordUsageOutcome(det, false); // third consecutive fail -> benched

    d.stream = ['L', 'L', 'L'];
    assert.strictEqual(d.detect().found, false); // benched, no longer fires
});

test('pattern state persists to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterns-'));
    const file = path.join(dir, 'patterns.json');

    const d1 = PatternDetector.load(file, { lengths: [3], minSupport: 2, targetMultiplier: 1.5 });
    for (let i = 0; i < 4; i++) {
        d1.observe(1.1); d1.observe(1.2); d1.observe(1.3); d1.observe(3.0);
    }

    const d2 = PatternDetector.load(file, { lengths: [3], minSupport: 2, targetMultiplier: 1.5 });
    assert.strictEqual(d2.patterns.size, d1.patterns.size);
    d2.rebuildStream([1.1, 1.2, 1.3]);
    assert.strictEqual(d2.detect().found, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('rebuildStream restores detection ability from raw history', () => {
    const d = makeDetector({ minSupport: 2 });
    for (let i = 0; i < 4; i++) {
        d.observe(1.1); d.observe(1.2); d.observe(1.3); d.observe(3.0);
    }
    const before = d.stream.length;
    const fresh = makeDetector({ minSupport: 2 });
    fresh.patterns = d.patterns;
    fresh.rebuildStream([1.1, 1.2, 1.3]);
    assert.strictEqual(fresh.detect().found, true);
    assert.ok(before > 0);
});
