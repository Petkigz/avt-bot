/**
 * npm run doctor — pre-flight checks before running the bot.
 * Prints PASS/WARN/FAIL per check; exits 1 if anything FAILs.
 */
require('dotenv').config();

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const pass = (name, detail = '') => results.push({ name, status: 'PASS', detail });
const warn = (name, detail = '') => results.push({ name, status: 'WARN', detail });
const fail = (name, detail = '') => results.push({ name, status: 'FAIL', detail });

// ---- Node version -----------------------------------------------------------
const major = parseInt(process.versions.node.split('.')[0], 10);
major >= 18
    ? pass('Node.js version', `v${process.versions.node}`)
    : fail('Node.js version', `v${process.versions.node} — need 18+`);

// ---- Required dependencies --------------------------------------------------
for (const dep of ['express', 'socket.io', 'puppeteer', 'winston', 'dotenv', 'mysql2']) {
    try {
        require.resolve(dep, { paths: [ROOT] });
        pass(`Dependency: ${dep}`);
    } catch {
        fail(`Dependency: ${dep}`, 'missing — run: npm install');
    }
}

// ---- Puppeteer browser binary ----------------------------------------------
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
        ? pass('Puppeteer Chrome binary', `custom: ${process.env.PUPPETEER_EXECUTABLE_PATH}`)
        : fail('Puppeteer Chrome binary', `PUPPETEER_EXECUTABLE_PATH points to a missing file`);
} else {
    try {
        const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer'));
        const exe = puppeteer.executablePath();
        fs.existsSync(exe)
            ? pass('Puppeteer Chrome binary', exe)
            : fail('Puppeteer Chrome binary', `not found — run: node node_modules/puppeteer/install.js`);
    } catch (error) {
        fail('Puppeteer Chrome binary', `not downloaded (${String(error.message).split('\n')[0]}) — run: node node_modules/puppeteer/install.js`);
    }
}

// ---- .env -------------------------------------------------------------------
const envPath = path.join(ROOT, '.env');
fs.existsSync(envPath)
    ? pass('.env file', 'present')
    : warn('.env file', 'missing — defaults will be used (copy .env.example to .env)');

// ---- Config loads -----------------------------------------------------------
let config = null;
try {
    config = require(path.join(ROOT, 'util', 'config'));
    pass('Config parses', `site=${config.SITE_ID} maxSessions=${config.SESSIONS.MAX} paper=${config.MODE.PAPER}`);
} catch (error) {
    fail('Config parses', error.message);
}

// ---- Site registry ----------------------------------------------------------
try {
    const { listSites } = require(path.join(ROOT, 'util', 'sites'));
    const sites = listSites();
    pass('Site registry', `${sites.length} profiles: ${sites.map((s) => s.id).join(', ')}`);
} catch (error) {
    fail('Site registry', error.message);
}

// ---- data/ writable -----------------------------------------------------------
const dataDir = config ? config.DATA_DIR : path.join(ROOT, 'data');
try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.doctor-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    pass('data/ directory writable', dataDir);
} catch (error) {
    fail('data/ directory writable', error.message);
}

// ---- accounts.json valid (if present) ----------------------------------------
const accountsFile = path.join(dataDir, 'accounts.json');
if (fs.existsSync(accountsFile)) {
    try {
        const raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        const list = Array.isArray(raw) ? raw : raw.accounts || [];
        pass('accounts.json valid', `${list.length} saved profile(s)`);
    } catch (error) {
        fail('accounts.json valid', `corrupt — ${error.message} (rename it and restart to rebuild)`);
    }
} else {
    warn('accounts.json', 'not created yet (first run creates it)');
}

// ---- Stale Chrome profile locks (pages-stop-opening culprit) ------------------
try {
    const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort'];
    const locked = [];
    for (const entry of fs.readdirSync(dataDir)) {
        if (!entry.startsWith('browser-profile')) continue;
        for (const lock of lockNames) {
            const file = path.join(dataDir, entry, lock);
            try { if (fs.lstatSync(file, { throwIfNoEntry: false })) locked.push(`${entry}/${lock}`); } catch { /* absent */ }
        }
    }
    if (locked.length === 0) {
        pass('Browser profile locks', 'no stale locks (the bot also self-clears them on launch)');
    } else {
        warn('Browser profile locks', `${locked.length} lock file(s) present: ${locked.slice(0, 3).join(', ')} — if Chrome is NOT running these are stale; the bot clears them automatically at launch, or close all Chrome windows and restart`);
    }
} catch { /* no profiles yet */ }

// ---- Dashboard port free ------------------------------------------------------
if (config && config.DASHBOARD.ENABLED) {
    const tester = net.createServer();
    tester.once('error', (error) => {
        fail('Dashboard port', `${config.DASHBOARD.PORT} busy — ${error.code}`);
        finish();
    });
    tester.listen(config.DASHBOARD.PORT, config.DASHBOARD.HOST, () => {
        tester.close(() => {
            pass('Dashboard port', `${config.DASHBOARD.PORT} free on ${config.DASHBOARD.HOST}`);
            networkCheck();
        });
    });
} else {
    networkCheck();
}

// ---- Network reachability (informational) --------------------------------------
function networkCheck() {
    let target = 'https://www.betpawa.ug';
    try {
        const { getSite } = require(path.join(ROOT, 'util', 'sites'));
        const site = getSite(config ? config.SITE_ID : 'betpawa.ug');
        if (site.baseUrl) target = site.baseUrl;
    } catch { /* default target */ }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    fetch(target, { method: 'GET', redirect: 'follow', signal: controller.signal })
        .then((res) => {
            clearTimeout(timer);
            pass('Network reachability', `${target} -> HTTP ${res.status}`);
            finish();
        })
        .catch((error) => {
            clearTimeout(timer);
            warn('Network reachability', `${target} unreachable (${error.message}) — proxy/firewall?`);
            finish();
        });
}

function finish() {
    console.log('\n================ aviator-bot doctor ================');
    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️ ' : '❌';
        console.log(`${icon} [${r.status}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    }
    const fails = results.filter((r) => r.status === 'FAIL').length;
    const warns = results.filter((r) => r.status === 'WARN').length;
    console.log('====================================================');
    console.log(`${fails === 0 ? '✅ Ready to run' : '❌ Fix the FAIL items first'} (${fails} fail, ${warns} warn, on ${os.platform()})\n`);
    process.exit(fails === 0 ? 0 : 1);
}
