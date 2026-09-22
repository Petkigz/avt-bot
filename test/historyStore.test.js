const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HistoryStore = require('../game/historyStore');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
    return path.join(dir, 'history.json');
}

test('appends and persists round values', () => {
    const file = tmpFile();
    const store = new HistoryStore(file);
    store.append(1.5);
    store.append(2.25);
    assert.deepStrictEqual(store.values, [1.5, 2.25]);
    assert.ok(fs.existsSync(file));
});

test('reload restores previously stored history (memory across restarts)', () => {
    const file = tmpFile();
    const s1 = new HistoryStore(file);
    s1.append(1.5);
    s1.append(2.25);
    s1.append(10.4);

    const s2 = new HistoryStore(file);
    assert.strictEqual(s2.load(), 3);
    assert.deepStrictEqual(s2.values, [1.5, 2.25, 10.4]);
});

test('invalid values are filtered on load and append', () => {
    const file = tmpFile();
    const s1 = new HistoryStore(file);
    s1.append(NaN);
    s1.append(-3);
    s1.append(0);
    s1.append(1.8);
    assert.deepStrictEqual(s1.values, [1.8]);

    fs.writeFileSync(file, JSON.stringify([1.1, 'junk', null, 2.2]));
    const s2 = new HistoryStore(file);
    s2.load();
    assert.deepStrictEqual(s2.values, [1.1, 2.2]);
});

test('history is capped at maxEntries', () => {
    const file = tmpFile();
    const store = new HistoryStore(file, 5);
    for (let i = 1; i <= 8; i++) store.append(i);
    assert.strictEqual(store.values.length, 5);
    assert.deepStrictEqual(store.values, [4, 5, 6, 7, 8]);
});

test('corrupt file falls back to empty history gracefully', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    const store = new HistoryStore(file);
    assert.strictEqual(store.load(), 0);
    assert.deepStrictEqual(store.values, []);
});

test('parallel-monitor duplicates within the dedupe window are dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-hs-'));
    const store = new HistoryStore(path.join(dir, 'h.json'));
    assert.equal(store.append(1.5), true);
    assert.equal(store.append(1.5), false); // same round, second monitor
    assert.equal(store.append(2.25), true);
    assert.deepEqual(store.values, [1.5, 2.25]);
});

test('identical crashes a full round apart are still recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-hs-'));
    const store = new HistoryStore(path.join(dir, 'h.json'));
    store.dedupeSameValueMs = 30; // shrink the window for the test
    store.append(1.5);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(store.append(1.5), true);
    assert.deepEqual(store.values, [1.5, 1.5]);
});
