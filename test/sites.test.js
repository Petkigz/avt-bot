const test = require('node:test');
const assert = require('node:assert/strict');
const { listSites, getSite, selectorsFor, SELECTOR_SETS } = require('../util/sites');

test('registry lists the built-in BetPawa regions plus custom', () => {
    const ids = listSites().map((s) => s.id);
    assert.ok(ids.includes('betpawa.ug'));
    assert.ok(ids.includes('betpawa.co.zm'));
    assert.ok(ids.includes('betpawa.co.mw'));
    assert.ok(ids.includes('custom'));
});

test('getSite returns known sites and falls back to custom', () => {
    const ug = getSite('betpawa.ug');
    assert.equal(ug.currency, 'UGX');
    assert.equal(ug.selectorSet, 'spribe');
    assert.equal(ug.loginFlow, 'manual');
    assert.equal(getSite('no.such.site').id, 'custom');
    assert.equal(getSite(null).id, 'custom');
});

test('all spribe-widget sites share the same selector set', () => {
    const ug = selectorsFor(getSite('betpawa.ug'));
    const zm = selectorsFor(getSite('betpawa.co.zm'));
    const mw = selectorsFor(getSite('betpawa.co.mw'));
    assert.deepEqual(ug, zm);
    assert.deepEqual(ug, mw);
    assert.equal(ug, SELECTOR_SETS.spribe);
    assert.ok(ug.BUBBLE_MULTIPLIER.length > 0);
    assert.ok(ug.BET_BUTTON.length > 0);
});

test('built-in sites expose working URLs; unknown sites degrade gracefully', () => {
    for (const s of listSites()) {
        assert.ok(Number.isFinite(s.minStake) && s.minStake >= 0, `${s.id} minStake`);
        assert.ok(typeof s.currency === 'string' && s.currency.length >= 3, `${s.id} currency`);
        if (s.id === 'custom') continue; // fully env-driven, empty until configured
        assert.match(s.baseUrl, /^https:\/\//, `${s.id} baseUrl`);
        // gameUrl is either empty (manual navigation) or a full https URL
        if (s.gameUrl !== '') assert.match(s.gameUrl, /^https:\/\//, `${s.id} gameUrl`);
    }
});
