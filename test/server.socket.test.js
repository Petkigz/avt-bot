const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const { startDashboard } = require('../server');
const AccountsManager = require('../util/accounts');

const quietLogger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    success: () => {}, critical: () => {}, event: () => {}
};

test('socket clients receive live session + site snapshots on connect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-sock-'));
    const dashboard = await startDashboard(0, quietLogger, {
        accounts: new AccountsManager(dir),
        dataDir: dir,
        getActiveSite: () => ({ id: 'betpawa.ug', name: 'BetPawa Uganda', currency: 'UGX' }),
        getSessions: () => [{
            accountId: 'a', accountLabel: 'main',
            siteId: 'betpawa.ug', siteName: 'BetPawa Uganda', currency: 'UGX',
            phase: 'monitoring', monitoring: true, roundsSeen: 7
        }]
    });
    const port = dashboard.server.address().port;
    const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    try {
        // Both snapshots are emitted in the same connect batch — listen for
        // both before either can arrive.
        const got = { sessions: null, status: null };
        client.on('sessions', (s) => { got.sessions = s; });
        client.on('siteStatus', (s) => { got.status = s; });
        await new Promise((resolve, reject) => {
            const t0 = Date.now();
            const timer = setInterval(() => {
                if (got.sessions && got.status) { clearInterval(timer); resolve(); }
                else if (Date.now() - t0 > 5000) {
                    clearInterval(timer);
                    reject(new Error('snapshot timeout (sessions/siteStatus)'));
                }
            }, 25);
        });
        const sessions = got.sessions;
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].phase, 'monitoring');
        assert.equal(sessions[0].roundsSeen, 7);

        const status = got.status;
        assert.equal(status.phase, 'active');
        assert.equal(status.siteId, 'betpawa.ug');
        assert.equal(status.siteName, 'BetPawa Uganda');

        // Unknown/inert client events must never crash the server.
        client.emit('switchSite', { siteId: 'betpawa.co.zm' });
        client.emit('switchAccount', { siteId: 'betpawa.ug', accountId: 'missing' });
        client.emit('confirmLogin');
        await new Promise((r) => setTimeout(r, 200));
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
        assert.equal(health.ok, true);
    } finally {
        client.close();
        await new Promise((resolve) => dashboard.server.close(resolve));
        dashboard.io.close();
    }
});
