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
        '2026-09-22T00:00:00Z,paper,betpawa.ug,betpawa.ug account,99,1.23,no,,none,0,,,,\n' +
        '2026-09-22T00:01:00Z,paper,betpawa.ug,work,100,2.00,no,,none,0,,,,\n' +
        '2026-09-22T00:02:00Z,paper,betpawa.co.zm,zm,10,3.00,no,,none,0,,,,\n');
    fs.writeFileSync(path.join(dir, 'trades.csv'),
        'ts,mode,site,account,roundId,stake,target,multiplier,pnl,won,tier\n' +
        '2026-09-22T00:00:00Z,paper,betpawa.ug,betpawa.ug account,99,100,1.3,1.31,30,yes,MICRO\n');
    const accounts = new AccountsManager(tmpDir());
    const mainAcct = accounts.add({ site: 'betpawa.ug', label: 'main' });
    accounts.touchLogin(mainAcct.id);
    const addedSites = [];

    await withServer({
        accounts,
        dataDir: dir,
        getActiveSite: () => ({ id: 'betpawa.ug', name: 'BetPawa Uganda' }),
        addSite: (site) => { addedSites.push(site); return site; },
        removeSite: (id) => {
            const i = addedSites.findIndex((s) => s.id === id);
            if (i < 0) return false;
            addedSites.splice(i, 1);
            return true;
        },
        getSessions: () => [{
            accountId: mainAcct.id,
            accountLabel: 'main',
            siteId: 'betpawa.ug',
            siteName: 'BetPawa Uganda',
            currency: 'UGX',
            phase: 'monitoring',
            monitoring: true,
            roundsSeen: 42
        }]
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
        assert.ok(acct[0].lastLoginAt); // saved login profile tracks last login
        assert.ok(!JSON.stringify(acct).toLowerCase().includes('password'));

        const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((r) => r.json());
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].phase, 'monitoring');
        assert.equal(sessions[0].roundsSeen, 42);

        const strategies = await fetch(`http://127.0.0.1:${port}/api/strategies`).then((r) => r.json());
        assert.ok(strategies.length >= 4);
        assert.ok(strategies.find((s) => s.name === 'MICRO'));
        assert.equal(typeof strategies[0].targetMultiplier, 'number');

        const bySite = await fetch(`http://127.0.0.1:${port}/api/history/bySite`).then((r) => r.json());
        assert.equal(bySite.sites.length, 2);
        const ug = bySite.sites.find((s) => s.site === 'betpawa.ug');
        const zm = bySite.sites.find((s) => s.site === 'betpawa.co.zm');
        assert.equal(ug.rounds, 2);
        assert.equal(ug.siteName, 'BetPawa Uganda');
        assert.ok(Math.abs(ug.avg - 1.615) < 0.001);
        assert.equal(ug.pctBelow15, 50);
        assert.equal(ug.accounts.length, 2);
        assert.deepEqual(ug.recent, [1.23, 2.0]);
        assert.equal(zm.rounds, 1);
        assert.equal(zm.avg, 3.0);

        const newAcct = await fetch(`http://127.0.0.1:${port}/api/accounts/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: 'betpawa.co.zm', label: 'zm' })
        }).then((r) => r.json());
        assert.equal(newAcct.site, 'betpawa.co.zm');
        const acct2 = await fetch(`http://127.0.0.1:${port}/api/accounts`).then((r) => r.json());
        assert.equal(acct2.length, 2);

        // Validation: unregistered site, empty label and the 50-account cap
        const badSite = await fetch(`http://127.0.0.1:${port}/api/accounts/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: 'evil.example', label: 'x' })
        });
        assert.equal(badSite.status, 400);
        const badLabel = await fetch(`http://127.0.0.1:${port}/api/accounts/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: 'betpawa.ug', label: '   ' })
        });
        assert.equal(badLabel.status, 400);
        for (let i = 0; i < 48; i++) accounts.add({ site: 'betpawa.ug', label: `filler ${i}` });
        const capped = await fetch(`http://127.0.0.1:${port}/api/accounts/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: 'betpawa.ug', label: 'one too many' })
        });
        assert.equal(capped.status, 400);
        assert.equal((await capped.json()).error, 'account limit reached (50)');

        const rounds = await fetch(`http://127.0.0.1:${port}/api/logs?type=rounds`).then((r) => r.json());
        assert.equal(rounds.rows.length, 3);
        // newest first
        assert.equal(rounds.rows[0].site, 'betpawa.co.zm');
        assert.equal(rounds.rows[0].crash, '3.00');
        const roundsOne = await fetch(`http://127.0.0.1:${port}/api/logs?type=rounds&limit=1`).then((r) => r.json());
        assert.equal(roundsOne.rows.length, 1);
        assert.equal(roundsOne.rows[0].site, 'betpawa.co.zm');
        const trades = await fetch(`http://127.0.0.1:${port}/api/logs?type=trades`).then((r) => r.json());
        assert.equal(trades.rows[0].won, 'yes');
        const invalid = await fetch(`http://127.0.0.1:${port}/api/logs?type=evil`).then((r) => r.json());
        assert.equal(invalid.type, 'rounds'); // unknown type degrades to rounds, never path-escapes

        // CSV/JSON export
        const dl = await fetch(`http://127.0.0.1:${port}/api/export?type=rounds`);
        assert.equal(dl.status, 200);
        assert.match(dl.headers.get('content-disposition') || '', /rounds\.csv/);
        assert.match(await dl.text(), /betpawa\.ug/);
        const dlBad = await fetch(`http://127.0.0.1:${port}/api/export?type=../../etc/passwd`);
        assert.equal(dlBad.status, 400);
        fs.unlinkSync(path.join(dir, 'trades.csv'));
        const dlMissing = await fetch(`http://127.0.0.1:${port}/api/export?type=trades`);
        assert.equal(dlMissing.status, 404);

        // Site management from the dashboard
        const noName = await fetch(`http://127.0.0.1:${port}/api/sites/new`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: 'https://x.example' })
        });
        assert.equal(noName.status, 400);
        const badUrl = await fetch(`http://127.0.0.1:${port}/api/sites/new`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'No Https', baseUrl: 'http://insecure.example' })
        });
        assert.equal(badUrl.status, 400);
        const added = await fetch(`http://127.0.0.1:${port}/api/sites/new`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Test Bookie', baseUrl: 'https://test.example', currency: 'TST', minStake: '5' })
        });
        assert.equal(added.status, 201);
        const addedJson = await added.json();
        assert.equal(addedJson.id, 'test.example');
        assert.equal(addedJson.minStake, 5);
        assert.equal(addedSites.length, 1);
        const delBuiltin = await fetch(`http://127.0.0.1:${port}/api/sites/betpawa.ug`, { method: 'DELETE' });
        assert.equal(delBuiltin.status, 400);
        const delUser = await fetch(`http://127.0.0.1:${port}/api/sites/test.example`, { method: 'DELETE' });
        assert.equal(delUser.status, 200);
        assert.equal(addedSites.length, 0);
    });
});

test('dashboard walks to the next free port and records it', async () => {
    const net = require('net');
    const dir = tmpDir();
    // Occupy a port first
    const blocker = net.createServer();
    const busyPort = await new Promise((resolve) => {
        blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
    });
    try {
        const dashboard = await startDashboard(busyPort, quietLogger, { dataDir: dir });
        try {
            assert.equal(dashboard.server.address().port, busyPort + 1);
            assert.equal(fs.readFileSync(path.join(dir, 'dashboard-port'), 'utf8'), String(busyPort + 1));
        } finally {
            await new Promise((resolve) => dashboard.server.close(resolve));
            dashboard.io.close();
        }
    } finally {
        blocker.close();
    }
});

test('PUT /api/strategies/:id hot-swaps or 400s on unknown', async () => {
    const calls = [];
    await withServer({
        setStrategy: (id) => {
            calls.push(id);
            if (id !== 'MICRO') throw new Error(`unknown strategy "${id}"`);
            return { name: 'MICRO' };
        }
    }, async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/strategies/MICRO`, { method: 'PUT' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { name: 'MICRO' });
        assert.deepEqual(calls, ['MICRO']);
        const bad = await fetch(`http://127.0.0.1:${port}/api/strategies/NOPE`, { method: 'PUT' });
        assert.equal(bad.status, 400);
    });
});
