const test = require('node:test');
const assert = require('node:assert');
const { startDashboard } = require('../server');

const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('dashboard serves /health and /api/history', async () => {
    const { io, server } = await startDashboard(0, quietLogger);
    const port = server.address().port;

    const health = await fetch(`http://localhost:${port}/health`);
    assert.strictEqual(health.status, 200);
    const hb = await health.json();
    assert.strictEqual(hb.ok, true);

    const hist = await fetch(`http://localhost:${port}/api/history`);
    assert.strictEqual(hist.status, 200);
    const body = await hist.json();
    assert.ok(body.stats, 'history stats present');
    assert.ok(Number.isFinite(body.stats.count), 'round count is a number');
    assert.ok(Array.isArray(body.recent), 'recent rounds array present');

    io.close();
    await new Promise((resolve) => server.close(resolve));
});
