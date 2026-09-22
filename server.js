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
 *   GET /api/strategies      — strategy presets for the UI launcher
 *   GET /api/sessions        — live bot browser sessions (site/account/phase)
 *   GET /api/logs?type=rounds|trades&limit=N — stored log history (JSON)
 *   GET /api/export?type=rounds|trades|history — download stored files
 *
 * Socket.IO:
 *   server -> client: newData, status, brain, trade, tradingStopped,
 *                     siteStatus {phase, site, account}, loginRequired,
 *                     sessions [live session snapshots],
 *                     controlState {awaitingLaunch, paused, strategy}
 *   client -> server: switchSite {siteId, accountId}, confirmLogin,
 *                     startSession {siteId, accountId, strategy},
 *                     pauseBetting, resumeBetting
 */
async function startDashboard(port, logger, deps = {}) {
    const dataDir = deps.dataDir || config.DATA_DIR;
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

        // Add a user-defined site from the dashboard (validated here,
        // persisted by deps.addSite).
        app.post('/api/sites/new', (req, res) => {
            if (!deps.addSite) return res.status(503).json({ error: 'site management unavailable' });
            const b = req.body || {};
            const str = (v) => (typeof v === 'string' ? v.trim() : '');
            const name = str(b.name);
            const baseUrl = str(b.baseUrl);
            if (!name || name.length > 60) return res.status(400).json({ error: 'name is required (max 60 chars)' });
            if (!/^https:\/\//.test(baseUrl)) return res.status(400).json({ error: 'baseUrl must start with https://' });
            const gameUrl = str(b.gameUrl);
            const loginUrl = str(b.loginUrl);
            if (gameUrl && !/^https:\/\//.test(gameUrl)) return res.status(400).json({ error: 'gameUrl must be empty or start with https://' });
            if (loginUrl && !/^https:\/\//.test(loginUrl)) return res.status(400).json({ error: 'loginUrl must start with https://' });
            const currency = str(b.currency) || 'UNITS';
            if (!/^[A-Za-z]{3,8}$/.test(currency)) return res.status(400).json({ error: 'currency must be 3-8 letters (e.g. UGX)' });
            const minStake = parseFloat(b.minStake);
            if (b.minStake !== '' && b.minStake !== undefined && (!Number.isFinite(minStake) || minStake < 0)) {
                return res.status(400).json({ error: 'minStake must be a number >= 0' });
            }
            // id: host-like slug, guaranteed unique
            let id = str(b.id) || baseUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
            if (!id) return res.status(400).json({ error: 'could not derive a site id' });
            let candidate = id;
            let n = 2;
            const taken = (x) => x === 'custom' || listSites().some((s) => s.id === x);
            while (taken(candidate)) candidate = `${id}-${n++}`;
            try {
                const site = deps.addSite({
                    id: candidate, name, baseUrl,
                    loginUrl: loginUrl || baseUrl,
                    gameUrl, currency,
                    minStake: Number.isFinite(minStake) ? minStake : 0,
                    notes: str(b.notes).slice(0, 200)
                });
                res.status(201).json(site);
            } catch (error) {
                res.status(400).json({ error: error.message });
            }
        });

        // Remove a user-defined site (built-ins are protected).
        app.delete('/api/sites/:id', (req, res) => {
            if (!deps.removeSite) return res.status(503).json({ error: 'site management unavailable' });
            const ok = deps.removeSite(req.params.id);
            if (!ok) return res.status(400).json({ error: 'only user-defined sites can be removed' });
            res.json({ removed: req.params.id });
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

        app.get('/api/strategies', (req, res) => {
            res.json(Object.values(config.BETTING_STRATEGIES).map((s) => ({
                name: s.name,
                initialBet: s.initialBet,
                minBet: s.minBet,
                maxBet: s.maxBet,
                targetMultiplier: s.targetMultiplier,
                stopLoss: s.stopLoss,
                takeProfit: s.takeProfit
            })));
        });

        // Switch strategy: hot-swaps the running session's strategy, or
        // remembers the choice for the next launch.
        app.put('/api/strategies/:id', (req, res) => {
            if (!deps.setStrategy) return res.status(503).json({ error: 'strategy switching unavailable' });
            try {
                res.json(deps.setStrategy(req.params.id));
            } catch (error) {
                res.status(400).json({ error: error.message });
            }
        });

        // Live diagnostic: what the monitor actually sees in the game frame.
        app.get('/api/debug/game', async (req, res) => {
            if (!deps.getGameDebug) return res.status(503).json({ error: 'debug unavailable' });
            try {
                res.json(await deps.getGameDebug(req.query.accountId));
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/api/accounts/new', (req, res) => {
            if (!deps.accounts) return res.status(503).json({ error: 'accounts unavailable' });
            const { site, label, notes } = req.body || {};
            // Input validation: site must be a registered profile, label is
            // capped, and the total number of stored profiles is capped so a
            // hostile/buggy client cannot spam the registry.
            const knownIds = listSites().map((s) => s.id);
            if (typeof site !== 'string' || !knownIds.includes(site)) {
                return res.status(400).json({ error: 'site must be a registered site id' });
            }
            if (typeof label !== 'string' || label.trim().length === 0 || label.length > 60) {
                return res.status(400).json({ error: 'label must be 1-60 characters' });
            }
            if (deps.accounts.list().length >= 50) {
                return res.status(400).json({ error: 'account limit reached (50)' });
            }
            const account = deps.accounts.add({ site, label: label.trim(), notes: typeof notes === 'string' ? notes.slice(0, 200) : '' });
            res.json({ id: account.id, site: account.site, label: account.label });
        });

        app.get('/api/export', (req, res) => {
            const allowed = { rounds: 'rounds.csv', trades: 'trades.csv', history: 'history.json' };
            const file = allowed[req.query.type];
            if (!file) return res.status(400).json({ error: 'invalid type (rounds|trades|history)' });
            const full = path.join(dataDir, file);
            if (!fs.existsSync(full)) return res.status(404).json({ error: 'no data stored yet' });
            res.download(full, file);
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
        const host = config.DASHBOARD.HOST;

        // Every new dashboard connection immediately gets the live state.
        io.on('connection', (socket) => {
            if (deps.getSessions) socket.emit('sessions', deps.getSessions());
            if (deps.getControlState) socket.emit('controlState', deps.getControlState());
            if (deps.getActiveSite) {
                const a = deps.getActiveSite() || {};
                socket.emit('siteStatus', {
                    phase: 'active',
                    siteId: a.id,
                    siteName: a.name,
                    currency: a.currency,
                    accountLabel: null
                });
            }
        });

        // Bind with automatic port fallback: if the configured port is busy,
        // walk up to 10 higher ports instead of failing to start.
        const tryListen = (p) => new Promise((res, rej) => {
            const onError = (error) => { server.removeListener('listening', onListening); rej(error); };
            const onListening = () => { server.removeListener('error', onError); res(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(p, host);
        });
        let bindPort = port;
        try {
            for (let attempt = 0; attempt <= 10; attempt++) {
                try {
                    await tryListen(bindPort);
                    break;
                } catch (error) {
                    if (error.code !== 'EADDRINUSE' || attempt === 10) throw error;
                    logger.warn(`Dashboard port ${bindPort} is busy — trying ${bindPort + 1}`);
                    bindPort++;
                }
            }
        } catch (error) {
            throw error;
        }

        const actualPort = server.address().port;
        // Tell the launcher (and anyone else) where the dashboard actually is.
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'dashboard-port'), String(actualPort));
        } catch { /* non-critical */ }
        logger.info(`Dashboard running at http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}${actualPort !== port ? ` (requested ${port} was busy)` : ''}`);
        return { io, server };
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
