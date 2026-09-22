const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/**
 * Live dashboard server.
 * Serves the UI in /public and broadcasts game events over socket.io.
 * (The original repo shipped the dashboard client but no server — this is it.)
 */
function startDashboard(port, logger) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.static(path.join(__dirname, 'public')));

        app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

        const server = http.createServer(app);
        const io = new Server(server);

        server.once('error', reject);
        server.listen(port, () => {
            logger.info(`Dashboard running at http://localhost:${port}`);
            resolve({ io, server });
        });
    });
}

module.exports = { startDashboard };
