'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    loadSiteStrategies, saveSiteStrategies, resolveSiteStrategy, siteStrategiesPath
} = require('../util/siteStrategies');

const PRESETS = {
    MICRO: { name: 'MICRO', initialBet: 100, minBet: 100, targetMultiplier: 1.3 },
    AGGRESSIVE: { name: 'AGGRESSIVE', initialBet: 2500, minBet: 500, targetMultiplier: 2.0 }
};
const FALLBACK = { name: 'CONSERVATIVE', initialBet: 500, minBet: 500, targetMultiplier: 1.2 };

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sitestrat-'));
}

test('loadSiteStrategies: missing file -> empty map (first run)', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(loadSiteStrategies(dir), {});
});

test('saveSiteStrategies + loadSiteStrategies round-trip', () => {
    const dir = tmpDir();
    const ok = saveSiteStrategies(dir, { 'betpawa.ug': 'AGGRESSIVE', 'fortebet.ug': 'micro' });
    assert.strictEqual(ok, true);
    const loaded = loadSiteStrategies(dir);
    assert.strictEqual(loaded['betpawa.ug'], 'AGGRESSIVE');
    // Stored normalized to upper-case preset names.
    assert.strictEqual(loaded['fortebet.ug'], 'MICRO');
});

test('loadSiteStrategies: corrupt / non-object files never throw', () => {
    const dir = tmpDir();
    fs.writeFileSync(siteStrategiesPath(dir), '{not json');
    assert.deepStrictEqual(loadSiteStrategies(dir), {});
    fs.writeFileSync(siteStrategiesPath(dir), '["a","b"]');
    assert.deepStrictEqual(loadSiteStrategies(dir), {});
    fs.writeFileSync(siteStrategiesPath(dir), '{"ok": 5, "good": "AGGRESSIVE"}');
    // Non-string values dropped, valid entries kept.
    assert.deepStrictEqual(loadSiteStrategies(dir), { good: 'AGGRESSIVE' });
});

test('resolveSiteStrategy: explicit valid choice wins over the fallback', () => {
    const got = resolveSiteStrategy({ 'a': 'AGGRESSIVE' }, 'a', PRESETS, FALLBACK);
    assert.strictEqual(got.name, 'AGGRESSIVE');
});

test('resolveSiteStrategy: no choice -> fallback default', () => {
    const got = resolveSiteStrategy({}, 'a', PRESETS, FALLBACK);
    assert.strictEqual(got.name, 'CONSERVATIVE');
});

test('resolveSiteStrategy: unknown persisted name falls back, never crashes', () => {
    const got = resolveSiteStrategy({ 'a': 'TURBO_DELETED_PRESET' }, 'a', PRESETS, FALLBACK);
    assert.strictEqual(got.name, 'CONSERVATIVE');
});

test('resolveSiteStrategy: no fallback either -> MICRO as last resort', () => {
    const got = resolveSiteStrategy({}, 'a', PRESETS, null);
    assert.strictEqual(got.name, 'MICRO');
    // A non-object fallback is ignored the same way.
    const got2 = resolveSiteStrategy({}, 'a', PRESETS, 'nonsense');
    assert.strictEqual(got2.name, 'MICRO');
});
