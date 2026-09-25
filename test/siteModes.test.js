'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    loadSiteModes, saveSiteModes, resolveSiteMode, siteModesPath,
    loadSiteQuotas, saveSiteQuotas, resolveSiteQuota, siteQuotasPath
} = require('../util/siteModes');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'avt-site-modes-test-'));
}

test('siteModesPath: points under the data dir', () => {
    const dir = '/tmp/avt-test-data';
    assert.strictEqual(siteModesPath(dir), path.join(dir, 'site-modes.json'));
});

test('loadSiteModes: missing file -> empty map (first run)', () => {
    const dir = makeTempDir();
    assert.deepStrictEqual(loadSiteModes(dir), {});
});

test('saveSiteModes + loadSiteModes round-trip', () => {
    const dir = makeTempDir();
    const map = { 'betpawa.ug': 'PLAIN', 'fortebet.ug': 'SMART' };
    assert.strictEqual(saveSiteModes(dir, map), true);
    const loaded = loadSiteModes(dir);
    assert.deepStrictEqual(loaded, map);
});

test('loadSiteModes: corrupt / non-object files never throw', () => {
    const dir = makeTempDir();
    fs.writeFileSync(siteModesPath(dir), 'not json at all');
    assert.deepStrictEqual(loadSiteModes(dir), {});
    fs.writeFileSync(siteModesPath(dir), '["not", "an", "object"]');
    assert.deepStrictEqual(loadSiteModes(dir), {});
    fs.writeFileSync(siteModesPath(dir), JSON.stringify({ good: 'PLAIN', bad: 123 }));
    assert.deepStrictEqual(loadSiteModes(dir), { good: 'PLAIN' });
});

test('resolveSiteMode: prefers explicit per-site choice, falls back safely', () => {
    const choices = { 'betpawa.ug': 'PLAIN', 'fortebet.ug': 'IRRATIONAL' };
    assert.strictEqual(resolveSiteMode(choices, 'betpawa.ug', 'SMART'), 'PLAIN');
    assert.strictEqual(resolveSiteMode(choices, 'fortebet.ug', 'SMART'), 'IRRATIONAL');
    assert.strictEqual(resolveSiteMode(choices, 'unknown.site', 'IRRATIONAL'), 'IRRATIONAL');
    assert.strictEqual(resolveSiteMode(choices, 'unknown.site'), 'SMART');
});

test('saveSiteQuotas + loadSiteQuotas + resolveSiteQuota round-trip', () => {
    const dir = makeTempDir();
    const quotas = { 'betpawa.ug': 25000, 'fortebet.ug': 50000 };
    assert.strictEqual(saveSiteQuotas(dir, quotas), true);
    const loaded = loadSiteQuotas(dir);
    assert.deepStrictEqual(loaded, quotas);

    assert.strictEqual(resolveSiteQuota(loaded, 'betpawa.ug', 10000), 25000);
    assert.strictEqual(resolveSiteQuota(loaded, 'unknown.site', 10000), 10000);
});
