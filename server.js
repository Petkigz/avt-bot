const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./util/config');
const { listSites } = require('./util/sites');

/**
 * Live dashboard server.
 *
 * REST (read APIs):
 *   GET /health              — liveness
 *   GET /api/history         — all-time stored rounds + summary statistics
 *   GET /api/history/bySite  — stored rounds aggregated per site/account
 *   GET /api/sites           — available site profiles (+ active site)
 *   GET /api/accounts        — stored accounts (metadata only, never credentials)
 *   GET /api/sessions        — live bot browser sessions (site/account/phase)
 *   GET /api/logs?type=rounds|trades&limit=N — stored log history (JSON)
 *
 * Socket.IO:
 *   server -> client: newData, status, brain, trade, tradingStopped,
 *                     siteStatus {phase, site, account}, loginRequired,
 *                     sessions [live session snapshots]
 *   client -> server: switchSite {siteId, accountId}, confirmLogin
 */
function startDashboard(port, logger, deps = {}) {
    const dataDir = deps.dataDir || config.DATA_DIR;
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.json());
        app.use(express.static(path.join(__dirname, 'public')));

        app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

        app.get('/api/history', (req, res) => {
            try {
                const file = path.join(dataDir, 'history.json');
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

        app.get('/api/history/bySite', (req, res) => {
            try {
                res.json(aggregateBySite(path.join(dataDir, 'rounds.csv')));
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.get('/api/sites', (req, res) => {
            res.json({
                sites: listSites(),
                active: deps.getActiveSite ? deps.getActiveSite() : null
            });
        });

        app.get('/api/accounts', (req, res) => {
            const accounts = deps.accounts ? deps.accounts.list() : [];
            // Never expose anything sensitive — metadata only.
            res.json(accounts.map((a) => ({
                id: a.id,
                site: a.site,
                label: a.label,
                notes: a.notes || '',
                lastLoginAt: a.lastLoginAt || null
            })));
        });

        app.get('/api/sessions', (req, res) => {
            res.json(deps.getSessions ? deps.getSessions() : []);
        });

        app.post('/api/accounts/new', (req, res) => {
            if (!deps.accounts) return res.status(503).json({ error: 'accounts unavailable' });
            const { site, label, notes } = req.body || {};
            if (!site) return res.status(400).json({ error: 'site is required' });
            const account = deps.accounts.add({ site, label, notes });
            res.json({ id: account.id, site: account.site, label: account.label });
        });

        app.get('/api/logs', (req, res) => {
            const type = req.query.type === 'trades' ? 'trades' : 'rounds';
            const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
            try {
                const file = path.join(dataDir, `${type}.csv`);
                if (!fs.existsSync(file)) return res.json({ type, rows: [] });
                const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
                if (lines.length < 2) return res.json({ type, rows: [] });
                const headers = parseCsvLine(lines[0]);
                const dataLines = lines.slice(1);
                const rows = dataLines.slice(-limit).reverse().map((line) => {
                    const values = parseCsvLine(line);
                    const obj = {};
                    headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
                    return obj;
                });
                res.json({ type, rows });
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

/**
 * Aggregates rounds.csv into per-site stats (rounds, avg, %-below-1.5x,
 * per-account counts, last 30 crashes per site) for the dashboard charts.
 */
function aggregateBySite(file) {
    if (!fs.existsSync(file)) return { source: 'rounds.csv', sites: [] };
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (lines.length < 2) return { source: 'rounds.csv', sites: [] };
    const headers = parseCsvLine(lines[0]);
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });
    const bySite = new Map();
    for (const line of lines.slice(1)) {
        const cols = parseCsvLine(line);
        const site = cols[idx.site] || 'unknown';
        const crash = parseFloat(cols[idx.crash]);
        if (!Number.isFinite(crash) || crash <= 0) continue;
        if (!bySite.has(site)) {
            bySite.set(site, { site, rounds: 0, sum: 0, below15: 0, accounts: new Map(), recent: [], lastTs: '' });
        }
        const agg = bySite.get(site);
        agg.rounds++;
        agg.sum += crash;
        if (crash < 1.5) agg.below15++;
        const acct = cols[idx.account] || '';
        if (acct) {
            const entry = agg.accounts.get(acct) || { label: acct, rounds: 0 };
            entry.rounds++;
            agg.accounts.set(acct, entry);
        }
        agg.recent.push(crash);
        if (agg.recent.length > 30) agg.recent.shift();
        const ts = cols[idx.ts] || '';
        if (ts > agg.lastTs) agg.lastTs = ts;
    }
    const known = listSites();
    const sites = [...bySite.values()].map((s) => {
        const match = known.find((k) => k.id === s.site);
        return {
            site: s.site,
            siteName: match ? match.name : s.site,
            rounds: s.rounds,
            avg: s.sum / s.rounds,
            pctBelow15: (s.below15 / s.rounds) * 100,
            accounts: [...s.accounts.values()],
            recent: s.recent,
            lastTs: s.lastTs
        };
    });
    sites.sort((a, b) => b.rounds - a.rounds);
    return { source: 'rounds.csv', sites };
}

/**
 * Minimal CSV line parser (handles quoted fields with commas).
 */
function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            out.push(cur); cur = '';
        } else cur += ch;
    }
    out.push(cur);
    return out;
}

module.exports = { startDashboard };
