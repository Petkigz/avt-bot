const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AccountsManager = require('../util/accounts');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'avt-accounts-'));
}

test('ensureDefault creates one default account per site, idempotently', () => {
    const mgr = new AccountsManager(tmpDir());
    const a = mgr.ensureDefault('betpawa.ug');
    const b = mgr.ensureDefault('betpawa.ug');
    assert.equal(a.id, b.id);
    assert.equal(mgr.list().length, 1);
    mgr.ensureDefault('betpawa.co.zm');
    assert.equal(mgr.list().length, 2);
});

test('account registry persists to disk', () => {
    const dir = tmpDir();
    const mgr = new AccountsManager(dir);
    mgr.add({ site: 'betpawa.ug', label: 'work' });
    const mgr2 = new AccountsManager(dir);
    assert.equal(mgr2.list().length, 1);
    assert.equal(mgr2.list()[0].label, 'work');
    assert.equal(mgr2.list()[0].site, 'betpawa.ug');
});

test('multiple accounts per site are allowed with distinct ids', () => {
    const mgr = new AccountsManager(tmpDir());
    const a = mgr.add({ site: 'betpawa.ug', label: 'one' });
    const b = mgr.add({ site: 'betpawa.ug', label: 'two' });
    assert.notEqual(a.id, b.id);
    assert.equal(mgr.list().length, 2);
    assert.equal(mgr.list('betpawa.ug').length, 2);
    assert.equal(mgr.list('betpawa.co.zm').length, 0);
});

test('profileDir gives each account an isolated browser directory', () => {
    const mgr = new AccountsManager(tmpDir());
    const a = mgr.add({ site: 'betpawa.ug', label: 'one' });
    const b = mgr.add({ site: 'betpawa.ug', label: 'two' });
    assert.notEqual(mgr.profileDir(a.id), mgr.profileDir(b.id));
    assert.ok(mgr.profileDir(a.id).includes(a.id));
});

test('remove drops the account from the registry', () => {
    const mgr = new AccountsManager(tmpDir());
    const a = mgr.add({ site: 'betpawa.ug', label: 'one' });
    mgr.add({ site: 'betpawa.ug', label: 'two' });
    mgr.remove(a.id);
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.list()[0].label, 'two');
    assert.equal(mgr.get(a.id), null);
});

test('metadata store never holds credentials', () => {
    const dir = tmpDir();
    const mgr = new AccountsManager(dir);
    mgr.add({ site: 'betpawa.ug', label: 'x', password: 'hunter-two-secret', pin: '999000' });
    const raw = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
    assert.ok(!raw.includes('hunter-two-secret'));
    assert.ok(!raw.includes('999000'));
    assert.ok(!raw.includes('password'));
    assert.ok(!raw.includes('pin'));
});
