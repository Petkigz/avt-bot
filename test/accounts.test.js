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

test('touchLogin records a last-login timestamp that persists', () => {
    const dir = tmpDir();
    const mgr = new AccountsManager(dir);
    const a = mgr.add({ site: 'betpawa.ug', label: 'one' });
    assert.equal(a.lastLoginAt, null);
    mgr.touchLogin(a.id);
    const mgr2 = new AccountsManager(dir);
    assert.ok(mgr2.get(a.id).lastLoginAt);
    assert.equal(typeof mgr.touchLogin('missing'), 'object'); // null-safe
});

test('update only allows whitelisted metadata fields', () => {
    const dir = tmpDir();
    const mgr = new AccountsManager(dir);
    const a = mgr.add({ site: 'betpawa.ug', label: 'one' });
    mgr.update(a.id, { label: 'renamed', notes: 'my notes', password: 'nope', site: 'evil' });
    const updated = mgr.get(a.id);
    assert.equal(updated.label, 'renamed');
    assert.equal(updated.notes, 'my notes');
    assert.equal(updated.password, undefined);
    assert.equal(updated.site, 'betpawa.ug');
});

test('lastActive session is remembered across restarts', () => {
    const dir = tmpDir();
    const mgr = new AccountsManager(dir);
    const a = mgr.add({ site: 'betpawa.co.zm', label: 'zm' });
    mgr.setLastActive('betpawa.co.zm', a.id);
    const mgr2 = new AccountsManager(dir);
    assert.equal(mgr2.getLastActive().siteId, 'betpawa.co.zm');
    assert.equal(mgr2.getLastActive().accountId, a.id);
    mgr2.remove(a.id); // removing the active account clears lastActive
    assert.equal(mgr2.getLastActive(), null);
});

test('legacy plain-array accounts.json still loads (backward compat)', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([
        { id: 'old-1', site: 'betpawa.ug', label: 'legacy' }
    ]));
    const mgr = new AccountsManager(dir);
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.get('old-1').label, 'legacy');
    assert.equal(mgr.getLastActive(), null);
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
