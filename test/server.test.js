const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startDashboard } = require('../server');
const AccountsManager = require('../util/accounts');

const quietLogger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    success: () => {}, critical: () => {}, event: () => {}
};

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'avt-srv-'));
}

async function withServer(deps, fn) {
    const dashboard = await startDashboard(0, quietLogger, deps);
    const port = dashboard.server.address().port;
    try {
        await fn(port);
    } finally {
        await new Promise((resolve) => dashboard.server.close(resolve));
        dashboard.io.close();
    }
}

test('server exposes health + history + sites + accounts + logs', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([1.23, 2.5, 1.8]));
    fs.writeFileSync(path.join(dir, 'rounds.csv'),
        'ts,mode,site,account,roundId,crash,betPlaced,stake,outcome,pnl,confidence,pattern,tier,regime\n' +
        '2026-09-22T00:00:00Z,paper,betpawa.ug,betpawa.ug account,99,1.23,no,,none,0,,,,\n');
    fs.writeFileSync(path.join(dir, 'trades.csv'),
        'ts,mode,site,account,roundId,stake,target,multiplier,pnl,won,tier\n' +
        '2026-09-22T00:00:00Z,paper,betpawa.ug,betpawa.ug account,99,100,1.3,1.31,30,yes,MICRO\n');
    const accounts = new AccountsManager(tmpDir());
    accounts.add({ site: 'betpawa.ug', label: 'main' });

    await withServer({
        accounts,
        dataDir: dir,
        getActiveSite: () => ({ id: 'betpawa.ug', name: 'BetPawa Uganda' })
    }, async (port) => {
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
        assert.equal(health.ok, true);

        const history = await fetch(`http://127.0.0.1:${port}/api/history`).then((r) => r.json());
        assert.equal(history.stats.count, 3);
        assert.deepEqual(history.recent, [1.23, 2.5, 1.8]);

        const sites = await fetch(`http://127.0.0.1:${port}/api/sites`).then((r) => r.json());
        assert.equal(sites.active.id, 'betpawa.ug');
        assert.ok(sites.sites.length >= 4);

        const acct = await fetch(`http://127.0.0.1:${port}/api/accounts`).then((r) => r.json());
        assert.equal(acct.length, 1);
        assert.equal(acct[0].label, 'main');
        assert.ok(!JSON.stringify(acct).toLowerCase().includes('password'));

        const newAcct = await fetch(`http://127.0.0.1:${port}/api/accounts/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: 'betpawa.co.zm', label: 'zm' })
        }).then((r) => r.json());
        assert.equal(newAcct.site, 'betpawa.co.zm');
        const acct2 = await fetch(`http://127.0.0.1:${port}/api/accounts`).then((r) => r.json());
        assert.equal(acct2.length, 2);

        const rounds = await fetch(`http://127.0.0.1:${port}/api/logs?type=rounds`).then((r) => r.json());
        assert.equal(rounds.rows.length, 1);
        assert.equal(rounds.rows[0].site, 'betpawa.ug');
        assert.equal(rounds.rows[0].crash, '1.23');
        const trades = await fetch(`http://127.0.0.1:${port}/api/logs?type=trades`).then((r) => r.json());
        assert.equal(trades.rows[0].won, 'yes');
        const invalid = await fetch(`http://127.0.0.1:${port}/api/logs?type=evil`).then((r) => r.json());
        assert.equal(invalid.type, 'rounds'); // unknown type degrades to rounds, never path-escapes
    });
});
