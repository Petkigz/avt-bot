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

test('built-in sites define login URLs and login-form selector hints', () => {
    for (const s of listSites()) {
        if (s.id === 'custom') continue; // env-driven, empty until configured
        assert.match(s.loginUrl, /^https:\/\//, `${s.id} loginUrl`);
        assert.ok(s.loginSelectors.usernameInput.length > 0, `${s.id} usernameInput`);
        assert.ok(s.loginSelectors.passwordInput.length > 0, `${s.id} passwordInput`);
        assert.ok(s.loginSelectors.submitButton.length > 0, `${s.id} submitButton`);
        assert.ok(s.loginSelectors.loggedInIndicator.length > 0, `${s.id} loggedInIndicator`);
        assert.ok(s.balanceSelector.length > 0, `${s.id} balanceSelector`);
        assert.ok(typeof s.notes === 'string' && s.notes.length > 0, `${s.id} notes`);
        assert.equal(s.loginFlow, 'manual', `${s.id} loginFlow`);
    }
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerSite, unregisterSite, loadUserSites, saveUserSites } = require('../util/sites');

test('registerSite adds a user site that behaves like a built-in', () => {
    const s = registerSite({ id: 'test-site-x', name: 'Test Bookie', baseUrl: 'https://test.example', currency: 'TST', minStake: 5, gameUrl: 'https://test.example/aviator' });
    assert.equal(s.loginFlow, 'manual');
    assert.equal(s.userDefined, true);
    assert.equal(getSite('test-site-x').name, 'Test Bookie');
    assert.ok(listSites().some((x) => x.id === 'test-site-x'));
    assert.equal(unregisterSite('test-site-x'), true);
    assert.equal(getSite('test-site-x').id, 'custom'); // falls back after removal
});

test('registerSite protects built-ins and rejects duplicates', () => {
    assert.throws(() => registerSite({ id: 'betpawa.ug', name: 'x', baseUrl: 'https://x.example' }));
    registerSite({ id: 'dup-site', name: 'a', baseUrl: 'https://a.example' });
    assert.throws(() => registerSite({ id: 'dup-site', name: 'b', baseUrl: 'https://b.example' }));
    unregisterSite('dup-site');
    assert.equal(unregisterSite('betpawa.ug'), false); // built-ins cannot be removed
});

test('user sites persist through a save/load round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-sites-'));
    const file = path.join(dir, 'user-sites.json');
    registerSite({ id: 'saved-site', name: 'Saved', baseUrl: 'https://saved.example', currency: 'SVX' });
    assert.equal(saveUserSites(file), true);
    assert.equal(unregisterSite('saved-site'), true);
    assert.equal(loadUserSites(file), 1);
    assert.equal(getSite('saved-site').name, 'Saved');
    unregisterSite('saved-site');
});

test('login detection indicators are broad enough for regional builds', () => {
    for (const id of ['betpawa.ug', 'betpawa.co.zm', 'betpawa.co.mw']) {
        const ind = getSite(id).loginSelectors.loggedInIndicator;
        assert.ok(ind.includes('balance'), `${id} checks balance`);
        assert.ok(ind.includes('logout'), `${id} checks logout marker`);
    }
});
