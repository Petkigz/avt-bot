const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./util/config');

/**
 * Live dashboard server.
 * Serves the UI in /public, broadcasts game events over socket.io, and
 * exposes the STORED history/memory over a small JSON API:
 *   GET /health      — liveness
 *   GET /api/history — all-time stored rounds + summary statistics
 */
function startDashboard(port, logger) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.static(path.join(__dirname, 'public')));

        app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

        app.get('/api/history', (req, res) => {
            try {
                const file = path.join(config.DATA_DIR, 'history.json');
                let values = [];
                if (fs.existsSync(file)) {
                    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
                    if (Array.isArray(raw)) {
                        values = raw.filter((v) => Number.isFinite(v) && v > 0);
                    }
                }
                const n = values.length;
                const stats = n > 0 ? {
                    count: n,
                    avg: values.reduce((a, v) => a + v, 0) / n,
                    min: Math.min(...values.slice(-5000)),
                    max: Math.max(...values.slice(-5000)),
                    pctBelow15: (values.filter((v) => v < 1.5).length / n) * 100,
                    pctAbove2: (values.filter((v) => v >= 2).length / n) * 100
                } : { count: 0 };
                res.json({ stats, recent: values.slice(-50) });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        const server = http.createServer(app);
        const io = new Server(server);

        server.once('error', reject);
        server.listen(port, () => {
            logger.info(`Dashboard running at http://localhost:${server.address().port}`);
            resolve({ io, server });
        });
    });
}

module.exports = { startDashboard };
