require('dotenv').config();

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const readline = require('readline');
const config = require('./util/config');
const logger = require('./util/logger');
const sleep = require('./util/sleep');
const FrameHelper = require('./util/frameHelper');
const { loadSiteStrategies, saveSiteStrategies, resolveSiteStrategy } = require('./util/siteStrategies');
const GameMonitor = require('./game/gameMonitor');
const BettingStrategy = require('./game/strategies');
const Database = require('./database/database');
const HistoryStore = require('./game/historyStore');
const Predictor = require('./game/predictor');
const PatternDetector = require('./game/patternDetector');
const CalibrationTracker = require('./game/calibration');
const PredictionLogger = require('./game/predictionLogger');
const { extractFeatures, FEATURE_VERSION } = require('./game/features');
const PaperLedger = require('./game/paperLedger');
const Recalibrator = require('./game/recalibrator');
const {
    runWalkForward: runSignalValidation,
    writeVerdict: writeSignalVerdict,
    readVerdict: readSignalVerdict
} = require('./scripts/walk-forward');
const {
    collectInFrame: pfCollectInFrame,
    parseCapturedTexts: pfParseCapturedTexts,
    ProvablyFairLog,
    analyze: pfAnalyze
} = require('./game/provablyFair');
const Bankroll = require('./game/bankroll');
const { SignalLifecycle } = require('./game/signalLifecycle');
const { readModelVerdict, loadFeatureModel, modelStaleness, readTournamentVerdict } = require('./game/modelLayer');
const { runSite: trainModelForSite, rowsForSite } = require('./scripts/train-model');
const Brain = require('./game/brain');
const CsvLog = require('./util/csvLog');
const AccountsManager = require('./util/accounts');
const { recordSample, roundsPerHour, isStalled } = require('./util/rate');
const { getSite, listSites, selectorsFor, loadUserSites, saveUserSites, registerSite, unregisterSite } = require('./util/sites');
const { startDashboard } = require('./server');

// ---------------------------------------------------------------------------
// Global runtime state
// ---------------------------------------------------------------------------
const accounts = new AccountsManager(config.DATA_DIR);

// User-defined sites (added from the dashboard) — load before anything else
// reads the registry.
const USER_SITES_FILE = path.join(config.DATA_DIR, 'user-sites.json');
const userSitesLoaded = loadUserSites(USER_SITES_FILE);
if (userSitesLoaded > 0) logger.info(`Loaded ${userSitesLoaded} user-defined site(s)`);

const sessions = new Map(); // accountId -> { browser, page, account, site }

// ---- Per-site strategy selection (module-level) -------------------------
// Each bookmaker is an independent book, so each site can run its OWN
// betting strategy. Choices persist in data/site-strategies.json. Declared
// at module level so the module-scoped sessionsSnapshot() can read them;
// main() mutates the same map and persists it on every change.
const siteStrategyChoices = loadSiteStrategies(config.DATA_DIR);
const persistSiteStrategies = () => saveSiteStrategies(config.DATA_DIR, siteStrategyChoices);
let defaultStrategyName = null; // global default, set once strategyConfig is chosen
let activeSite = getSite(config.SITE_ID);
let dashboard = null;
let loginWaiter = null; // {resolve} while waiting for the user to log in
let shuttingDown = false;   // global: graceful shutdown in progress
let switchInProgress = false; // global: site/account switch in progress
let awaitingUiLaunch = false; // UI_START: waiting for the dashboard LAUNCH button
let uiLaunchWaiter = null;

function emitSiteStatus(phase, extra = {}) {
    if (!dashboard) return;
    dashboard.io.emit('siteStatus', {
        phase,
        siteId: activeSite.id,
        siteName: activeSite.name,
        accountLabel: extra.accountLabel || null,
        ...extra
    });
}

// ---------------------------------------------------------------------------
// Live view mirror: streams screenshots of a session's page to the dashboard
// and forwards clicks back (local-only convenience, no iframe possible since
// bookmakers block framing).
// ---------------------------------------------------------------------------
function stopMirror(session) {
    if (session.mirrorTimer) {
        clearInterval(session.mirrorTimer);
        session.mirrorTimer = null;
    }
}

function startMirror(session) {
    stopMirror(session);
    session.mirrorTimer = setInterval(async () => {
        try {
            if (!session.page || session.page.isClosed()) return stopMirror(session);
            const dims = await session.page.evaluate(() => ({
                w: window.innerWidth, h: window.innerHeight
            }));
            const img = await session.page.screenshot({
                type: 'jpeg', quality: 45, encoding: 'base64'
            });
            if (dashboard) {
                dashboard.io.emit('mirrorFrame', {
                    accountId: session.account.id, img, w: dims.w, h: dims.h
                });
            }
        } catch (error) {
            logger.debug(`Mirror frame failed: ${error.message}`);
        }
    }, 1300);
}

function stopAllMirrors() {
    for (const session of sessions.values()) stopMirror(session);
}

function sessionsSnapshot() {
    return [...sessions.values()].map((s) => {
        const monitoring = !!s.monitor;
        if (monitoring) recordSample(s.rateWindow, s.monitor.roundId);
        return {
            accountId: s.account.id,
            accountLabel: s.account.label,
            siteId: s.site.id,
            siteName: s.site.name,
            currency: s.site.currency,
            phase: s.phase || 'starting',
            monitoring,
            // The strategy THIS site's engine runs (per-site selection).
            strategy: monitoring && s.monitor.strategy
                ? s.monitor.strategy.name
                : (siteStrategyChoices[s.site.id] || defaultStrategyName),
            roundsSeen: monitoring ? s.monitor.roundId : 0,
            roundsPerHour: monitoring ? Math.round(roundsPerHour(s.rateWindow) * 10) / 10 : 0,
            stalled: monitoring && isStalled(s.rateWindow),
            balance: monitoring ? s.monitor.lastBalance : null
        };
    });
}

function emitSessions() {
    if (dashboard) dashboard.io.emit('sessions', sessionsSnapshot());
}

function setSessionPhase(session, phase) {
    session.phase = phase;
    emitSessions();
}

/**
 * UI_START: resolves when the dashboard sends startSession.
 */
function waitForUiLaunch() {
    return new Promise((resolve) => {
        uiLaunchWaiter = {
            resolve: (payload) => { uiLaunchWaiter = null; resolve(payload); }
        };
    });
}

// ---------------------------------------------------------------------------
// Interactive site + account selection (CLI dropdown), then strategy
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

/**
 * CLI site/account selector.
 *  - SITE env set           -> use it (no prompt)
 *  - TTY, no SITE env       -> interactive dropdown of sites, then accounts
 *  - no TTY, no SITE env    -> restore the last-active site/account
 * Falls back to the default site + default account.
 */
async function selectSiteAndAccount() {
    let site = getSite(config.SITE_ID);

    if (process.env.SITE) {
        logger.info(`Site selected via SITE env: ${site.name}`);
    } else if (process.stdin.isTTY) {
        const sites = listSites();
        console.log('\nAvailable sites:');
        sites.forEach((s, i) => console.log(`  ${i + 1}. ${s.id} — ${s.name} (${s.currency})`));
        const choice = await askQuestion(`Select site (1-${sites.length}) [default 1]: `);
        const idx = parseInt(choice, 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < sites.length) {
            site = sites[idx];
        } else if (choice.trim() !== '') {
            logger.warn(`Invalid choice "${choice.trim()}" — using ${site.id}`);
        }
    } else {
        const last = accounts.getLastActive();
        if (last && last.siteId) {
            site = getSite(last.siteId);
            logger.info(`Restoring last-active site: ${site.id}`);
        }
    }

    const saved = accounts.list(site.id);
    let account = null;

    if (process.stdin.isTTY) {
        console.log(`\nSaved login profiles for ${site.id}:`);
        if (saved.length === 0) console.log('  (none yet)');
        saved.forEach((a, i) => {
            const lastLogin = a.lastLoginAt ? ` — last login ${a.lastLoginAt.slice(0, 10)}` : '';
            console.log(`  ${i + 1}. "${a.label}"${lastLogin}`);
        });
        console.log(`  ${saved.length + 1}. + Create a new account`);
        const choice = await askQuestion(`Select account (1-${saved.length + 1}) [default 1]: `);
        const n = parseInt(choice, 10);
        if (n === saved.length + 1) {
            const label = (await askQuestion('Label for the new account: ')).trim() || `${site.id} account`;
            account = accounts.add({ site: site.id, label });
        } else if (Number.isInteger(n) && n >= 1 && n <= saved.length) {
            account = saved[n - 1];
        } else if (choice.trim() !== '') {
            logger.warn(`Invalid choice "${choice.trim()}" — using the first/default account`);
        }
    }

    if (!account) {
        const last = accounts.getLastActive();
        account = (last && last.siteId === site.id && accounts.get(last.accountId)) ||
            accounts.ensureDefault(site.id);
    }
    return { site, account };
}

function listStrategyCatalog() {
    return Object.values(config.BETTING_STRATEGIES)
        .map((s) => `${s.name}: initial ${s.initialBet}, min ${s.minBet}, max ${s.maxBet}, ` +
            `target ${s.targetMultiplier}x, martingale x${s.martingaleMultiplier}, ` +
            `stop-loss ${s.stopLoss}, take-profit ${s.takeProfit}`)
        .join('\n  ');
}

async function selectStrategy() {
    if (config.STRATEGY) {
        const preset = config.BETTING_STRATEGIES[config.STRATEGY];
        if (preset) {
            logger.info(`Strategy selected via STRATEGY env: ${preset.name}`);
            return { ...preset };
        }
        logger.warn(
            `Unknown STRATEGY "${config.STRATEGY}" — valid options: ` +
            `${Object.keys(config.BETTING_STRATEGIES).join(', ')}`
        );
    }
    if (!process.stdin.isTTY) {
        logger.warn('No interactive terminal detected — defaulting to MICRO strategy');
        return { ...config.BETTING_STRATEGIES.MICRO };
    }
    console.log('\nAvailable Strategies (amounts are in the ACTIVE SITE\'S currency):');
    console.log('1. MICRO — tiny stakes, recommended default');
    console.log('2. CONSERVATIVE — lower risk, smaller profits');
    console.log('3. MODERATE — balanced risk and reward');
    console.log('4. AGGRESSIVE — higher risk, larger potential profits');
    console.log('5. CUSTOM — define your own parameters\n');
    console.log('Full parameter catalog:');
    console.log('  ' + listStrategyCatalog() + '\n');

    const choice = await askQuestion('Select strategy (1-5): ');
    switch (choice) {
        case '2': return { ...config.BETTING_STRATEGIES.CONSERVATIVE };
        case '3': return { ...config.BETTING_STRATEGIES.MODERATE };
        case '4': return { ...config.BETTING_STRATEGIES.AGGRESSIVE };
        case '5': return customStrategySetup();
        case '1':
        default:
            if (choice !== '1') logger.warn('Invalid choice, using MICRO strategy');
            return { ...config.BETTING_STRATEGIES.MICRO };
    }
}

async function customStrategySetup(attempt = 1) {
    if (attempt > 3) {
        logger.error('Too many invalid attempts — falling back to MICRO strategy');
        return { ...config.BETTING_STRATEGIES.MICRO };
    }
    console.log(`\nCustom strategy setup (attempt ${attempt}/3) — amounts in the active site's currency`);
    const askNum = async (label) => parseFloat(await askQuestion(label));
    const strategy = {
        name: 'CUSTOM',
        initialBet: await askNum('Initial bet amount (e.g. 100): '),
        maxBet: await askNum('Maximum bet amount: '),
        minBet: await askNum('Minimum bet amount: '),
        targetMultiplier: await askNum('Target multiplier (e.g., 1.3): '),
        stopLoss: await askNum('Stop loss amount: '),
        takeProfit: await askNum('Take profit amount: '),
        martingaleMultiplier: await askNum('Martingale multiplier (e.g., 1.4): '),
        averageMultiplierThreshold: await askNum('Average multiplier threshold to trigger bets (e.g., 1.8): ')
    };
    const { ok, errors } = BettingStrategy.validate(strategy);
    if (!ok) {
        errors.forEach((e) => logger.warn(e));
        return customStrategySetup(attempt + 1);
    }
    return strategy;
}

// ---------------------------------------------------------------------------
// Browser sessions (one persistent browser + profile per account)
// ---------------------------------------------------------------------------
/**
 * Is this page essentially the site's home/login page? Home pages of betting
 * sites embed Aviator TEASER widgets (and odds grids full of bare numbers)
 * that content-discovery happily matches — but they are NOT the playable
 * game. Anywhere on the home page we must navigate to the real game URL
 * instead of concluding "Aviator is already open".
 */
function isSiteHomeUrl(url, site) {
    const raw = String(url || '').trim();
    if (!raw || raw === 'about:blank') return true;
    const normalize = (u) => {
        try {
            const p = new URL(u);
            return (p.origin + p.pathname).replace(/\/+$/, '');
        } catch (error) { return ''; }
    };
    const here = normalize(raw);
    if (!here) return true;
    return here === normalize(site.baseUrl) ||
        (!!site.loginUrl && here === normalize(site.loginUrl));
}

async function gotoSafe(page, url, label) {
    if (!url) return false;
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: config.NAVIGATION.TIMEOUT });
        return true;
    } catch (error) {
        logger.warn(`Navigation to ${label || url} did not reach networkidle2, continuing: ${error.message}`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.NAVIGATION.TIMEOUT });
            return true;
        } catch (error2) {
            logger.error(`Navigation to ${label || url} failed: ${error2.message}`);
            return false;
        }
    }
}

/**
 * Clears stale Chrome profile lock files. When the bot (or the PC) exits
 * uncleanly, Chrome can leave lock files behind that make the next launch
 * fail with "failed to launch browser" — the classic cause of "the pages
 * stopped opening". Deleting them is safe: a RUNNING Chrome would refuse to
 * give them up, so success here means the lock was stale.
 */
function clearStaleProfileLocks(userDataDir) {
    if (!userDataDir) return [];
    const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort'];
    const removed = [];
    for (const name of lockNames) {
        const file = path.join(userDataDir, name);
        try {
            if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) {
                fs.rmSync(file, { force: true, recursive: false });
                removed.push(name);
            }
        } catch (error) { /* not present or not removable */ }
    }
    return removed;
}

// --- Crash recovery -------------------------------------------------------
// When a site's browser window dies on its own (Chromium crash, out of memory,
// forced close) that is NOT a site logout — but without recovery the session
// just evaporates and the bot parks on a "please log in" prompt. So an
// unexpected disconnect relaunches the session automatically, with a windowed
// cap so a machine that keeps crashing a site does not loop forever.
const crashRestarts = new Map(); // accountId -> { count, windowStart }
const MAX_CRASH_RESTARTS = 3;
const CRASH_RESTART_WINDOW_MS = 5 * 60 * 1000; // budget resets after 5 quiet minutes
const CRASH_RESTART_DELAY_MS = 4000;

function scheduleCrashRestart(account, site) {
    const now = Date.now();
    let rec = crashRestarts.get(account.id);
    if (!rec || now - rec.windowStart > CRASH_RESTART_WINDOW_MS) {
        rec = { count: 0, windowStart: now };
    }
    rec.count += 1;
    crashRestarts.set(account.id, rec);

    if (rec.count > MAX_CRASH_RESTARTS) {
        logger.error(
            `"${account.label}" (${site.name}) keeps crashing (${rec.count} times in ` +
            `${Math.round(CRASH_RESTART_WINDOW_MS / 60000)} min) — stopping auto-restart. ` +
            'Fix: close other heavy programs/browser windows to free memory, then reopen ' +
            'this site from the dashboard (Sites panel → open). This is a browser crash, not a logout.'
        );
        emitSiteStatus('error', {
            message: `${site.name} browser keeps crashing — free up memory, then reopen it from the Sites panel`,
            accountLabel: account.label
        });
        return;
    }

    logger.warn(
        `"${account.label}" (${site.name}) browser closed unexpectedly — this is a browser ` +
        `crash, NOT a site logout. Auto-restarting in ${CRASH_RESTART_DELAY_MS / 1000}s ` +
        `(attempt ${rec.count}/${MAX_CRASH_RESTARTS}).`
    );
    setTimeout(() => {
        if (shuttingDown || switchInProgress) return;
        if (sessions.has(account.id)) return; // something else already reopened it
        (async () => {
            try {
                const session = await launchSession(account, site);
                await navigateSessionToGame(session);
            } catch (error) {
                logger.error(`Auto-restart of "${account.label}" (${site.name}) failed: ${error.message.split('\n')[0]}`);
            }
        })();
    }, CRASH_RESTART_DELAY_MS);
}

async function launchSession(account, site) {
    const launchOptions = {
        headless: config.BROWSER.HEADLESS,
        defaultViewport: null,
        args: [
            '--start-maximized',
            // Stability flags: when several site windows run side by side,
            // Windows/Chromium can suspend or "occlude" the window that is
            // not in front, which is a common cause of the browser randomly
            // disconnecting/crashing mid-session. These keep every window
            // fully awake so a backgrounded site does not drop its session.
            '--disable-features=CalculateNativeWinOcclusion',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-dev-shm-usage'
        ],
        // Per-account persistent profile: log in once per account, stays logged in.
        userDataDir: accounts.profileDir(account.id)
    };
    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
    } catch (firstError) {
        // Self-heal: stale profile locks from an unclean exit are the most
        // common reason a previously-working bot suddenly opens no pages.
        const removed = clearStaleProfileLocks(launchOptions.userDataDir);
        if (removed.length > 0) {
            logger.warn(`Browser failed to start (${firstError.message.split('\n')[0]}); cleared stale profile lock(s) [${removed.join(', ')}] — retrying once`);
        } else {
            logger.warn(`Browser failed to start (${firstError.message.split('\n')[0]}) — retrying once`);
        }
        try {
            browser = await puppeteer.launch(launchOptions);
        } catch (secondError) {
            const hint = /Could not find|Failed to launch|cannot find/i.test(secondError.message)
                ? 'Fix: Chrome is missing or corrupted — run "npm install" again, then launcher option [2] health check. If it persists, delete data/browser-profile* folders and retry (you will need to log in once more).'
                : 'Fix: close ALL Chrome/Chromium windows (Windows: Task Manager -> End task on every Chrome process), then restart the bot. If it still fails, reboot the PC once to release locked profile files.';
            logger.error(`Browser still failed to start after retry: ${secondError.message.split('\n')[0]}. ${hint}`);
            emitSiteStatus('error', { message: `Browser failed to start — ${hint}` });
            throw secondError;
        }
    }
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.NAVIGATION.TIMEOUT);

    const session = { browser, page, account, site, monitor: null, phase: 'launching', rateWindow: [] };
    sessions.set(account.id, session);
    emitSessions();

    browser.on('disconnected', () => {
        const wasCancelled = session.cancelled === true;
        sessions.delete(account.id);
        emitSessions();
        logger.warn(`Browser session closed for account "${account.label}" (${site.name})`);
        // Only treat "no sessions left" as fatal when it is unexpected —
        // during shutdown or a site switch we close browsers on purpose.
        if (sessions.size === 0 && !shuttingDown && !switchInProgress) {
            logger.error('No browser sessions left — exiting for supervisor restart');
            process.exit(1);
        }
        // An unexpected, uncancelled death of the window is a browser crash,
        // not a site logout — relaunch the session instead of losing it.
        if (!shuttingDown && !switchInProgress && !wasCancelled) {
            scheduleCrashRestart(account, site);
        }
    });

    logger.info(`Browser session started: account "${account.label}" on ${site.name}`);
    return session;
}

/**
 * Checks the page for the site's logged-in indicators (loginSelectors.
 * loggedInIndicator + balance element). Returns:
 *   true  — logged-in elements found
 *   false — page examined, nothing found (still logged out / wrong login)
 *   null  — cannot verify (no indicators configured, page busy/closed)
 * The bot NEVER touches credentials — this only reads the page state.
 */
async function isLoggedIn(page, site) {
    const sel = site.loginSelectors || {};
    const candidates = String(sel.loggedInIndicator || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    if (site.balanceSelector) candidates.push(site.balanceSelector);
    if (candidates.length === 0) return null;
    try {
        if (page.isClosed()) return null;
        // Selector match first; if the site's class names differ, fall back
        // to a text heuristic ("log out" / "sign out" only appears when
        // a session exists).
        return await page.evaluate((list) => {
            try {
                if (list.some((s) => {
                    try { return !!document.querySelector(s); } catch (e) { return false; }
                })) return true;
                const text = (document.body && document.body.innerText || '').slice(0, 30000);
                return /\blog\s*out\b|\bsign\s*out\b/i.test(text);
            } catch (e) {
                return false;
            }
        }, candidates);
    } catch (error) {
        return null; // navigating or busy — unknown
    }
}

/**
 * One confirmation round: resolves when the user says they're logged in
 * (dashboard button or terminal ENTER).
 */
function waitLoginConfirmation(session) {
    return new Promise((resolve) => {
        loginWaiter = {
            account: session.account,
            resolve: () => { loginWaiter = null; resolve(); }
        };
        logger.warn(
            `>> LOG IN to ${session.site.name} in the browser window now ` +
            `(login page: ${session.site.loginUrl || session.site.baseUrl}). ` +
            `Wrong PIN? The site itself rejects it — just retry. ` +
            `Then click "I'm logged in" on the dashboard` +
            (process.stdin.isTTY ? ' (or press ENTER here)' : '') + '.'
        );
        if (process.stdin.isTTY) {
            askQuestion('>> Press ENTER when logged in...\n').then(() => {
                if (loginWaiter) loginWaiter.resolve();
            });
        }
    });
}

/**
 * Full login flow with VERIFICATION and AUTO-DETECT:
 *  - while waiting, the page is polled every 3s for logged-in indicators;
 *    success is detected automatically (no click needed)
 *  - after a manual confirmation, the page state is checked; if the site
 *    still looks logged out the user gets up to 3 attempts
 *  - never blocks forever: falls through to watcher mode with a warning
 */
async function waitForLogin(session) {
    const site = session.site;

    // Already logged in? The persistent browser profile keeps the site
    // session between runs, so normally nothing needs to happen here.
    const pre = await isLoggedIn(session.page, site);
    if (pre === true) {
        accounts.touchLogin(session.account.id);
        logger.info(`${site.name}: already logged in — remembered from your persistent profile, no action needed`);
        return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        setSessionPhase(session, 'loginRequired');
        emitSiteStatus('loginRequired', { accountLabel: session.account.label, attempt });

        // Race: user confirmation vs auto-detection vs session cancellation.
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearInterval(poll);
                if (loginWaiter && loginWaiter.account.id === session.account.id) loginWaiter = null;
                resolve();
            };
            waitLoginConfirmation(session).then(finish);
            const poll = setInterval(async () => {
                if (done) return;
                if (session.cancelled || session.page.isClosed()) return finish();
                const state = await isLoggedIn(session.page, site);
                if (state === true) {
                    logger.info(`Login auto-detected for "${session.account.label}" on ${site.name}`);
                    if (loginWaiter && loginWaiter.account.id === session.account.id) loginWaiter.resolve();
                }
            }, 3000);
        });

        if (session.cancelled || session.page.isClosed()) return;

        const state = await isLoggedIn(session.page, site);
        if (state === true) {
            accounts.touchLogin(session.account.id);
            logger.info(`Login VERIFIED on ${site.name} — profile remembered`);
            return;
        }
        if (state === null) {
            accounts.touchLogin(session.account.id);
            logger.warn(`${site.name}: no login indicator available — continuing on your confirmation`);
            return;
        }
        // state === false: page still looks logged out.
        if (attempt >= 2) {
            // The user insists they logged in — trust them rather than
            // deadlock; monitoring works either way, betting needs the site.
            accounts.touchLogin(session.account.id);
            logger.warn(
                `${site.name}: logged-in state not detected, but trusting your confirmation ` +
                `(the site may use a layout the bot does not recognize)`
            );
            return;
        }
        logger.warn(
            `Login NOT detected on ${site.name} (attempt ${attempt}/3) — the page still looks ` +
            'logged out. Check the browser window (wrong PIN? expired code?) and confirm again.'
        );
        emitSiteStatus('loginRequired', { accountLabel: session.account.label, loginFailed: true, attempt });
    }
    logger.warn(
        `Proceeding without a confirmed login on ${site.name} — the watcher keeps running; ` +
        'betting cannot work until the site shows a logged-in state.'
    );
}

/**
 * Polls the page (all frames) for the game widget, up to timeoutMs.
 */
async function waitForGameWidget(page, site, timeoutMs = 25000) {
    const selectors = selectorsFor(site);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            if (!page.isClosed() && await FrameHelper.findGameMarker(page, selectors.BUBBLE_MULTIPLIER)) return true;
        } catch (error) { /* page busy */ }
        await sleep(1500);
    }
    return false;
}

/**
 * Logs what the page actually contains when the game widget is not found —
 * frame URLs and titles — so a stale deep link or a missing click-through
 * (PLAY / real-money prompt) can be spotted from the logs alone.
 */
async function logPageDiagnostics(page, site) {
    try {
        if (page.isClosed()) return;
        const url = page.url();
        const frames = page.frames().map((f) => f.url()).filter(Boolean);
        logger.warn(`${site.name} diagnosis — page URL: ${url}`);
        logger.warn(`${site.name} diagnosis — ${frames.length} frame(s): ${frames.slice(0, 6).join(' | ')}`);
        const spribeFrames = page.frames().filter((f) => /spribe|aviator/i.test(f.url() || ''));
        if (spribeFrames.length > 0) {
            logger.warn(`${site.name}: Spribe/Aviator frame IS loaded — dumping its internal structure so the layout can be mapped:`);
            for (const frame of spribeFrames.slice(0, 2)) {
                try {
                    const summary = await frame.evaluate(() => {
                        const counts = new Map();
                        const all = document.querySelectorAll('*');
                        const limit = Math.min(all.length, 20000);
                        for (let i = 0; i < limit; i++) {
                            const cls = (all[i].getAttribute('class') || '').trim();
                            if (cls) {
                                const key = all[i].tagName.toLowerCase() + '.' + cls.split(/\s+/).slice(0, 2).join('.');
                                counts.set(key, (counts.get(key) || 0) + 1);
                            }
                        }
                        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
                        const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 300);
                        return { elements: all.length, top, text };
                    });
                    logger.warn(`${site.name} frame structure (${summary.elements} elements) — most common classes: ` +
                        summary.top.map(([k, v]) => `${k}(${v})`).join(', '));
                    logger.warn(`${site.name} frame visible text: "${summary.text}"`);
                } catch (error) {
                    logger.warn(`${site.name}: could not inspect frame ${frame.url()}: ${error.message}`);
                }
            }
            logger.warn(`${site.name}: paste the "frame structure" lines above into the chat — they reveal the layout classes.`);
        } else {
            logger.warn(`${site.name}: no Spribe/Aviator frame loaded yet — the page may need a click (PLAY / real-money prompt) or a manual open of Aviator from the menu.`);
        }
    } catch (error) {
        logger.debug(`Diagnostics failed: ${error.message}`);
    }
}

async function navigateSessionToGame(session) {
    const { page, site } = session;
    await gotoSafe(page, site.baseUrl, `${site.name} home`);

    // The browser/page can die during that navigation (a crash). A dead page
    // can never show a login screen, so skip the manual login flow for it —
    // the disconnect handler is already relaunching the session.
    if (session.page.isClosed()) {
        logger.warn(`Session for "${session.account.label}" (${site.name}) lost its browser before login — auto-restart will take over`);
        return;
    }

    if (site.loginFlow === 'manual') {
        await waitForLogin(session);
    }

    // Session was cancelled (another switch happened) or closed while we
    // were waiting for the login confirmation — stop navigating it.
    if (session.cancelled || session.page.isClosed()) {
        logger.warn(`Session for "${session.account.label}" cancelled during login wait`);
        return;
    }

    // Already on the game page (you opened Aviator yourself)? Don't
    // re-navigate — that would throw away the working page. EXCEPTION: on
    // the site's HOME page this check is unreliable (home pages embed
    // Aviator teaser widgets + odds grids that look like the round strip),
    // so there we ALWAYS proceed to the real game URL.
    let currentUrl = '';
    try { currentUrl = session.page.url(); } catch (error) { /* closed */ }
    if (!isSiteHomeUrl(currentUrl, site) &&
            await FrameHelper.findGameMarker(page, selectorsFor(site).BUBBLE_MULTIPLIER).catch(() => null)) {
        logger.info(`${site.name}: Aviator is already open — staying on this page`);
        setSessionPhase(session, 'active');
        emitSiteStatus('active', { accountLabel: session.account.label });
        return;
    }

    if (site.gameUrl) {
        setSessionPhase(session, 'navigating');
        await gotoSafe(page, site.gameUrl, `${site.name} Aviator`);
        // Verify the deep link actually produced the game widget — some sites
        // change paths or need a different entry after login.
        if (await waitForGameWidget(page, site, 25000)) {
            setSessionPhase(session, 'active');
            emitSiteStatus('active', { accountLabel: session.account.label });
        } else {
            logger.warn(
                `${site.name}: the Aviator deep link did not show the game widget ` +
                `(${site.gameUrl}). If the page shows a PLAY or real-money prompt, click it once; ` +
                'otherwise open Aviator from the site menu — the watcher will find it.'
            );
            await logPageDiagnostics(page, site);
            setSessionPhase(session, 'findGame');
            emitSiteStatus('findGame', { accountLabel: session.account.label });
        }
    } else {
        logger.warn(`${site.name}: no deep link configured — open Aviator from the site menu; the watcher will find it`);
        setSessionPhase(session, 'findGame');
        emitSiteStatus('findGame', { accountLabel: session.account.label });
    }
}

/**
 * Switch the bot to another site/account. Triggered from the dashboard.
 */
async function switchSite({ siteId, accountId } = {}) {
    switchInProgress = true;
    try {
        const site = getSite(siteId);
        const account = (accountId && accounts.get(accountId)) || accounts.ensureDefault(site.id);
        logger.info(`Site switch requested: ${site.name} / account "${account.label}"`);
        emitSiteStatus('switching', { accountLabel: account.label });

        // A pending login wait belongs to the previous target — cancel it so
        // the old navigation stops blocking on a session that is being closed.
        if (loginWaiter) loginWaiter.resolve();

        // Enforce the concurrent-session cap (close the oldest over the cap,
        // but never the account we are switching TO — that one re-navigates).
        while (sessions.size >= config.SESSIONS.MAX) {
            const oldestId = sessions.keys().next().value;
            if (oldestId === account.id) break;
            const old = sessions.get(oldestId);
            old.cancelled = true;
            logger.info(`Session cap reached — closing "${old.account.label}"`);
            try { await old.browser.close(); } catch (error) { /* already closed */ }
            sessions.delete(oldestId);
        }

        // Same account already open? Just re-navigate it (account switching =
        // closing the old profile's browser and opening the new one).
        let session = sessions.get(account.id);
        activeSite = site;
        if (!session) {
            session = await launchSession(account, site);
        } else {
            session.site = site;
            emitSessions();
        }
        accounts.setLastActive(site.id, account.id);
        await navigateSessionToGame(session);
        emitSiteStatus(site.gameUrl ? 'active' : 'findGame', { accountLabel: account.label });
        emitSessions();
        logger.info(`Site switch complete: ${site.name} / "${account.label}"`);
    } finally {
        switchInProgress = false;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    logger.info('Starting Aviator Bot (multi-site)...');
    logger.info(`Registered sites: ${listSites().map((s) => s.id).join(', ')}`);
    if (config.MODE.PAPER) {
        logger.warn('=====================================================================');
        logger.warn('PAPER MODE: observing + logging hypothetical trades. NO REAL BETS.');
        logger.warn('Set PAPER_MODE=false in .env only after you trust the behavior.');
        logger.warn('=====================================================================');
    } else {
        logger.error('LIVE MODE: the bot WILL place real bets. Loss limits are enforced.');
    }

    // ---- Dashboard FIRST: UI_START mode and live controls depend on it ----
    // The per-site engine registry is declared BEFORE the dashboard is built
    // so UI handlers (strategy switch, resets) never touch a binding that is
    // still in the temporal dead zone — before launch the map is just empty.
    const engines = new Map();
    let primaryEngine = null;
    let brain = null;          // assigned after strategy selection (handlers are null-safe)
    let strategyConfig = null;
    let pendingStrategyName = null; // strategy picked in the UI before launch
    // Per-site strategy resolution: a site's explicit choice wins; otherwise
    // the global default (whatever was picked at launch) applies.
    const strategyConfigForSite = (siteId) => resolveSiteStrategy(
        siteStrategyChoices, siteId, config.BETTING_STRATEGIES, strategyConfig);
    let paperMode = config.MODE.PAPER; // live-switchable from the dashboard
    // Reassigned once the per-site engines exist; early dashboard requests
    // simply see an empty snapshot instead of crashing.
    let profitsSnapshot = () => ({ paperMode: null, sites: [] });
    let controlState = () => ({
        awaitingLaunch: awaitingUiLaunch,
        paused: brain ? brain.paused : false,
        strategy: strategyConfig ? strategyConfig.name : pendingStrategyName,
        // Per-site strategy map (siteId -> preset name) so the dashboard can
        // show and edit each site's strategy independently.
        siteStrategies: { ...siteStrategyChoices },
        mode: paperMode ? 'paper' : 'live'
    });
    const emitControlState = () => { if (dashboard) dashboard.io.emit('controlState', controlState()); };

    if (config.DASHBOARD.ENABLED) {
        try {
            // ---- Provably-fair capture (implementation-weakness audit) ----
            // Scans the live page for the game's fair-data panel (seeds,
            // hashes, nonces), persists everything per site, and reports
            // anomalies such as seed reuse or revealed plaintext seeds.
            const pfLogs = new Map();
            const pfLogFor = (siteId) => {
                const safe = String(siteId || 'unknown').replace(/[^a-z0-9.-]/gi, '-');
                if (!pfLogs.has(safe)) {
                    pfLogs.set(safe, new ProvablyFairLog(path.join(config.DATA_DIR, `provablyfair-${safe}.jsonl`)));
                }
                return pfLogs.get(safe);
            };
            // opts: { auto } — auto scans run on a timer and stay silent unless
            // they actually capture fair-panel content (no log spam).
            const scanProvablyFair = async (accountId, opts = {}) => {
                const s = (accountId && sessions.get(accountId)) || sessions.values().next().value;
                if (!s || !s.page || s.page.isClosed()) return { error: 'no open session — launch one first' };
                let frames = [];
                try { frames = s.page.frames(); } catch (error) { return { error: `frames unavailable: ${error.message}` }; }
                const collected = [];
                for (const frame of frames) {
                    try {
                        const data = await frame.evaluate(pfCollectInFrame);
                        if (data && ((data.texts && data.texts.length) || (data.buttons && data.buttons.length))) {
                            collected.push(data);
                        }
                    } catch (error) { /* frame detached or not ready */ }
                }
                const found = collected.map((c) => ({
                    frame: c.url,
                    buttons: c.buttons,
                    ...pfParseCapturedTexts(c.texts)
                }));
                const siteId = s.site.id;
                const log = pfLogFor(siteId);
                for (const f of found) {
                    log.record({ site: siteId, frame: f.frame, hex64: f.hex64, serverSeed: f.serverSeed, serverSeedHash: f.serverSeedHash, clientSeed: f.clientSeed, nonce: f.nonce, labels: (f.labels || []).length });
                }
                const analysis = pfAnalyze(log.readAll());
                if (found.length === 0) {
                    if (!opts.auto) logger.info(`Provably-fair scan [${siteId}]: no fair-panel content visible — open the shield/"Provably Fair" panel inside the game, then scan again`);
                } else {
                    logger.info(`Provably-fair scan [${siteId}${opts.auto ? ' (auto)' : ''}]: captured ${found.length} frame(s), ${analysis.distinctHex64} distinct 64-hex values; anomalies: ${analysis.anomalies.length || 'none'}`);
                }
                return { site: siteId, framesScanned: frames.length, found, analysis };
            };

            // ---- Automatic provably-fair capture (option 3, live wiring) ----
            // While a session is open, sweep the game frames periodically for
            // fair-panel evidence (seeds / hashes / nonces). Silent and
            // best-effort: a scan that finds nothing just moves on, so this
            // never disturbs betting. Evidence accumulates in
            // data/provablyfair-<site>.jsonl and feeds "npm run fair:audit".
            const PF_AUTO_INTERVAL_MS = 5 * 60 * 1000;
            const pfAutoTimer = setInterval(() => {
                const hasLiveSession = [...sessions.values()].some((ss) => ss && ss.page && !ss.page.isClosed());
                if (!hasLiveSession) return;
                scanProvablyFair(null, { auto: true }).catch(() => { /* best-effort */ });
            }, PF_AUTO_INTERVAL_MS);
            pfAutoTimer.unref();

            const dashboardDeps = {
                accounts,
                getActiveSite: () => ({ id: activeSite.id, name: activeSite.name, currency: activeSite.currency }),
                getSiteStrategies: () => ({
                    choices: { ...siteStrategyChoices },
                    default: strategyConfig ? strategyConfig.name : pendingStrategyName
                }),
                getSessions: sessionsSnapshot,
                getControlState: controlState,
                profits: () => profitsSnapshot(),
                getProvablyFair: scanProvablyFair,
                getGameDebug: async (accountId) => {
                    const s = (accountId && sessions.get(accountId)) || sessions.values().next().value;
                    if (!s) return { error: 'no session' };
                    if (s.monitor) return s.monitor.dumpState();
                    return {
                        error: 'monitor not attached yet',
                        phase: s.phase,
                        url: s.page.isClosed() ? null : s.page.url()
                    };
                },
                addSite: (site) => {
                    const s = registerSite(site);
                    saveUserSites(USER_SITES_FILE);
                    logger.info(`Site added from dashboard: ${s.name} (${s.id})`);
                    return s;
                },
                removeSite: (id) => {
                    const ok = unregisterSite(id);
                    if (ok) {
                        saveUserSites(USER_SITES_FILE);
                        logger.info(`User site removed: ${id}`);
                    }
                    return ok;
                },
                setStrategy: (id, siteId) => {
                    const preset = config.BETTING_STRATEGIES[String(id || '').toUpperCase()];
                    if (!preset) throw new Error(`unknown strategy "${id}"`);
                    const siteKey = String(siteId || '').trim();
                    if (siteKey) {
                        // ---- Per-site strategy switch ---------------------
                        // Persisted choice + hot-swap ONLY this site's engine,
                        // monitors and paper book — every other site keeps its
                        // own strategy, progression and capital untouched.
                        siteStrategyChoices[siteKey] = preset.name;
                        persistSiteStrategies();
                        const engine = engines.get(siteKey);
                        if (engine) {
                            const strat = new BettingStrategy({ ...preset });
                            engine.brain.setStrategy(strat); // retargets model/patterns
                            engine.strategy = strat;
                            engine.strategyConfig = { ...preset };
                            if (engine.bankroll) {
                                engine.bankroll.minStake = preset.minBet;
                                if (config.MODE.PAPER) {
                                    engine.paperCapital = config.MODE.PAPER_BANKROLL > 0
                                        ? config.MODE.PAPER_BANKROLL : preset.initialBet * 100;
                                    engine.bankroll.setPaperReference(engine.paperCapital);
                                }
                            }
                            for (const s of sessions.values()) {
                                if (!s.site || s.site.id !== siteKey || !s.monitor) continue;
                                s.monitor.strategy = new BettingStrategy({ ...preset });
                                if (s.monitor.betManager) {
                                    s.monitor.betManager.setStrategy(s.monitor.strategy);
                                }
                                if (s.monitor.statsTracker) s.monitor.statsTracker.reset();
                            }
                            // Fresh strategy = fresh paper book for THIS site.
                            try { resetPaperLedgers(siteKey); } catch (error) { /* engines not up yet */ }
                            logger.warn(`Strategy for ${siteKey} switched to ${preset.name} from the dashboard (site progression reset)`);
                        } else {
                            logger.info(`Strategy for ${siteKey} set to ${preset.name} — takes effect when its engine starts`);
                        }
                        emitControlState();
                        return { name: preset.name, site: siteKey };
                    }
                    // ---- Global default switch (no site context) ----------
                    // Sets the DEFAULT strategy and hot-swaps every engine that
                    // has NO explicit per-site choice. Sites with their own
                    // pinned strategy keep it — a global switch must never
                    // silently overwrite a deliberate per-site selection.
                    strategyConfig = { ...preset };
                    pendingStrategyName = preset.name;
                    defaultStrategyName = preset.name;
                    if (engines.size === 0 && brain) {
                        // Pre-launch: swap the bootstrap brain only.
                        brain.setStrategy(new BettingStrategy({ ...preset }));
                        if (config.MODE.PAPER) {
                            const paperCapital = config.MODE.PAPER_BANKROLL > 0
                                ? config.MODE.PAPER_BANKROLL : preset.initialBet * 100;
                            bankroll.setPaperReference(paperCapital);
                        }
                        logger.warn(`Default strategy switched to ${preset.name} (no engines running yet)`);
                        emitControlState();
                        return { name: preset.name, site: null };
                    }
                    let swapped = 0;
                    for (const e of engines.values()) {
                        if (siteStrategyChoices[e.siteId]) continue; // pinned per site
                        const strat = new BettingStrategy({ ...preset });
                        e.brain.setStrategy(strat);
                        e.strategy = strat;
                        e.strategyConfig = { ...preset };
                        if (e.bankroll) {
                            e.bankroll.minStake = preset.minBet;
                            if (config.MODE.PAPER) {
                                e.paperCapital = config.MODE.PAPER_BANKROLL > 0
                                    ? config.MODE.PAPER_BANKROLL : preset.initialBet * 100;
                                e.bankroll.setPaperReference(e.paperCapital);
                            }
                        }
                        try { resetPaperLedgers(e.siteId); } catch (error) { /* engines not up yet */ }
                        swapped++;
                    }
                    // Bet managers + monitors keep their own strategy
                    // references — swap them for the non-pinned sites only.
                    for (const s of sessions.values()) {
                        if (!s.monitor) continue;
                        if (s.site && siteStrategyChoices[s.site.id]) continue;
                        s.monitor.strategy = new BettingStrategy({ ...preset });
                        if (s.monitor.betManager) {
                            s.monitor.betManager.setStrategy(s.monitor.strategy);
                        }
                        if (s.monitor.statsTracker) s.monitor.statsTracker.reset();
                    }
                    logger.warn(`Default strategy switched to ${preset.name} from the dashboard — applied to ${swapped} site(s); sites with their own pinned strategy were left untouched`);
                    emitControlState();
                    return { name: preset.name, site: null };
                }
            };
            dashboard = await startDashboard(config.DASHBOARD.PORT, logger, dashboardDeps);
            // server.js already sends the sessions/siteStatus snapshot on
            // connect; index.js only wires the command events.
            dashboard.io.on('connection', (socket) => {
                const doSwitch = (payload) => {
                    switchSite(payload || {}).catch((error) => {
                        logger.error(`Site/account switch failed: ${error.message}`);
                        emitSiteStatus('error', { message: error.message });
                    });
                };
                socket.on('switchSite', doSwitch);
                socket.on('switchAccount', doSwitch); // same flow: {siteId, accountId}
                // Profits panel: current snapshot now, updates flow on every
                // round/trade; the reset button restarts the paper simulation.
                socket.emit('profits', profitsSnapshot());
                socket.on('resetPaperLedgers', ({ siteId } = {}) => {
                    try { resetPaperLedgers(siteId || null); } catch (error) {
                        logger.error(`Paper ledger reset failed: ${error.message}`);
                    }
                });
                // Open an ADDITIONAL session side by side (multi-account
                // observation), limited by MAX_SESSIONS.
                const openExtraSession = async (account, site) => {
                    if (sessions.has(account.id)) {
                        logger.info(`Session for "${account.label}" is already open`);
                        return;
                    }
                    if (sessions.size >= config.SESSIONS.MAX) {
                        logger.warn(
                            `Cannot open "${account.label}": session cap reached ` +
                            `(MAX_SESSIONS=${config.SESSIONS.MAX}). Raise MAX_SESSIONS in .env to run more accounts side by side.`
                        );
                        emitSiteStatus('error', {
                            message: `Session cap reached (MAX_SESSIONS=${config.SESSIONS.MAX}) — raise MAX_SESSIONS in .env to open more accounts`
                        });
                        return;
                    }
                    try {
                        const session = await launchSession(account, site);
                        await navigateSessionToGame(session);
                    } catch (error) {
                        logger.error(`Failed to open session for "${account.label}": ${error.message}`);
                    }
                };
                socket.on('openSession', (payload) => {
                    const p = payload || {};
                    const site = getSite(p.siteId);
                    const account = (p.accountId && accounts.get(p.accountId)) || null;
                    if (!account) { logger.warn('Open session: unknown account'); return; }
                    openExtraSession(account, site).catch(() => {});
                });
                socket.on('openAllSessions', () => {
                    (async () => {
                        for (const account of accounts.list()) {
                            if (sessions.size >= config.SESSIONS.MAX) break;
                            await openExtraSession(account, getSite(account.site));
                        }
                    })().catch(() => {});
                });
                socket.on('confirmLogin', () => {
                    if (loginWaiter) loginWaiter.resolve();
                });
                socket.on('startSession', (payload) => {
                    if (!uiLaunchWaiter) {
                        logger.warn('Launch requested, but the bot is not waiting for a launch (already running?)');
                        return;
                    }
                    const p = payload || {};
                    const site = getSite(p.siteId);
                    const account = (p.accountId && accounts.get(p.accountId)) || accounts.ensureDefault(site.id);
                    // An explicit pick wins; otherwise keep the site's saved
                    // strategy; otherwise the pending/global default.
                    const preset = config.BETTING_STRATEGIES[
                        String(p.strategy || siteStrategyChoices[site.id] || pendingStrategyName || 'MICRO').toUpperCase()
                    ] || config.BETTING_STRATEGIES.MICRO;
                    // Launching WITH a chosen strategy makes it this site's
                    // pinned strategy (per-site selection).
                    siteStrategyChoices[site.id] = preset.name;
                    persistSiteStrategies();
                    logger.info(`Launch requested from dashboard: ${site.name} / "${account.label}" / ${preset.name}`);
                    uiLaunchWaiter.resolve({ site, account, strategyConfig: { ...preset } });
                });
                socket.on('pauseBetting', () => {
                    // Every per-site brain must hear the kill-switch — pausing
                    // only the bootstrap brain would leave running sites live.
                    let applied = false;
                    if (brain) { brain.paused = true; applied = true; }
                    for (const e of engines.values()) { e.brain.paused = true; applied = true; }
                    if (applied) { logger.warn('Betting PAUSED from the dashboard (all sites)'); emitControlState(); }
                });
                socket.on('resumeBetting', () => {
                    let applied = false;
                    if (brain) { brain.paused = false; applied = true; }
                    for (const e of engines.values()) { e.brain.paused = false; applied = true; }
                    if (applied) { logger.info('Betting RESUMED from the dashboard (all sites)'); emitControlState(); }
                });
                // Strategy hot-swap (running session) or pre-launch selection.
                // With `site` the switch is scoped to that site only.
                socket.on('setStrategy', ({ strategy, site } = {}) => {
                    try {
                        dashboardDeps.setStrategy(strategy, site);
                    } catch (error) {
                        logger.error(`Strategy change failed: ${error.message}`);
                    }
                });
                // Observe-only <-> live betting toggle (dashboard switch)
                socket.on('setMode', ({ mode } = {}) => {
                    const toPaper = mode !== 'live';
                    if (toPaper === paperMode) return;
                    paperMode = toPaper;
                    for (const s of sessions.values()) {
                        if (s.monitor) s.monitor.betManager.paperMode = toPaper;
                    }
                    if (brain) brain.mode = toPaper ? 'paper' : 'live';
                    for (const e of engines.values()) e.brain.mode = toPaper ? 'paper' : 'live';
                    if (toPaper) {
                        logger.warn('Mode switched to OBSERVE-ONLY from the dashboard — no real bets');
                    } else {
                        logger.error('Mode switched to LIVE from the dashboard — REAL BETS are now possible (limits still enforced)');
                    }
                    emitControlState();
                });
                // Live view mirror (screenshot stream + click-through)
                socket.on('mirrorStart', ({ accountId } = {}) => {
                    const s = sessions.get(accountId);
                    if (s) { logger.info(`Live view started for "${s.account.label}"`); startMirror(s); }
                });
                socket.on('mirrorStop', ({ accountId } = {}) => {
                    const s = sessions.get(accountId);
                    if (s) stopMirror(s);
                });
                socket.on('mirrorClick', async ({ accountId, x, y } = {}) => {
                    const s = sessions.get(accountId);
                    if (!s || s.page.isClosed()) return;
                    try {
                        await s.page.mouse.click(Number(x) || 0, Number(y) || 0);
                    } catch (error) {
                        logger.debug(`Mirror click failed: ${error.message}`);
                    }
                });
                // Re-navigate a session to its Aviator page on demand
                socket.on('renavigate', ({ accountId } = {}) => {
                    const s = accountId ? sessions.get(accountId) : sessions.values().next().value;
                    if (!s) return;
                    const selectors = selectorsFor(s.site);
                    let hereUrl = '';
                    try { hereUrl = s.page.url(); } catch (error) { /* closed */ }
                    const onHome = isSiteHomeUrl(hereUrl, s.site);
                    FrameHelper.findGameMarker(s.page, selectors.BUBBLE_MULTIPLIER)
                        .catch(() => null)
                        .then(async (found) => {
                            if (found && !onHome) {
                                logger.info(`${s.site.name}: Aviator is already open — nothing to do`);
                                emitSiteStatus('active', { accountLabel: s.account.label });
                                return;
                            }
                            if (!s.site.gameUrl) {
                                logger.warn(`${s.site.name}: no deep link — open Aviator from the menu; the watcher will find it`);
                                emitSiteStatus('findGame', { accountLabel: s.account.label });
                                return;
                            }
                            logger.info(`Re-navigating "${s.account.label}" to ${s.site.name} Aviator page (dashboard request)`);
                            await gotoSafe(s.page, s.site.gameUrl, `${s.site.name} Aviator`);
                            if (await waitForGameWidget(s.page, s.site, 25000)) {
                                emitSiteStatus('active', { accountLabel: s.account.label });
                            } else {
                                logger.warn(`${s.site.name}: deep link did not show the game — if a PLAY/real-money prompt is visible, click it once; otherwise open Aviator from the menu; the watcher will find it`);
                                await logPageDiagnostics(s.page, s.site);
                                emitSiteStatus('findGame', { accountLabel: s.account.label });
                            }
                        });
                });
            });
            dashboard.io.on('disconnect', stopAllMirrors);
        } catch (error) {
            logger.error(`Dashboard failed to start: ${error.message}`);
        }
    }

    // ---- Site + account + strategy: CLI dropdown OR dashboard LAUNCH ----
    let selection;
    if (config.UI_START) {
        if (!dashboard) {
            logger.error('UI_START=true but the dashboard is disabled — set DASHBOARD_ENABLED=true');
            process.exit(1);
        }
        awaitingUiLaunch = true;
        emitControlState();
        logger.warn('=====================================================================');
        logger.warn(`UI_START: open http://localhost:${config.DASHBOARD.PORT} and press LAUNCH in Mission Control`);
        logger.warn('=====================================================================');
        const launch = await waitForUiLaunch();
        awaitingUiLaunch = false;
        selection = { site: launch.site, account: launch.account };
        strategyConfig = launch.strategyConfig;
        defaultStrategyName = strategyConfig.name;
        emitControlState();
    } else {
        strategyConfig = await selectStrategy();
        defaultStrategyName = strategyConfig.name;
        selection = await selectSiteAndAccount();
    }

    logger.info(
        `Strategy: ${strategyConfig.name} | initial bet ${strategyConfig.initialBet} | ` +
        `min ${strategyConfig.minBet} | max ${strategyConfig.maxBet} | ` +
        `target ${strategyConfig.targetMultiplier}x | martingale x${strategyConfig.martingaleMultiplier} | ` +
        `stop-loss ${strategyConfig.stopLoss} | take-profit ${strategyConfig.takeProfit}`
    );
    if (config.MICRO_ONLY) {
        logger.warn('MICRO_ONLY safety profile: stakes stay capped at micro size (no promotion to full stakes)');
    }

    // ---- Memory: history, model, patterns, bankroll (shared across sites:
    // ---- Long-term memory (persists across restarts) ----
    // NOTE (2026-09-22): parallel BetPawa-vs-Fortebet monitoring proved the
    // bookmakers run SEPARATE Aviator round streams — the values do not line
    // up across sites. history.json is kept as a legacy bootstrap archive;
    // each site now gets its OWN engine (memory + model + patterns + brain)
    // via engineFor() below, so one game's rounds never pollute another's.
    const historyStore = new HistoryStore(path.join(config.DATA_DIR, 'history.json'));
    const roundsLoaded = historyStore.load();

    const safeSiteId = (siteId) => String(siteId || 'unknown').replace(/[^a-z0-9.-]/gi, '-');

    // Per-site persistent memories (data/history-<site>.json): every site's
    // observed rounds survive restarts and can be compared. The 4s same-value
    // dedupe protects against two accounts on the SAME site double-reporting.
    const siteHistoryStores = new Map();
    const siteHistoryFor = (siteId) => {
        const key = String(siteId || 'unknown');
        if (!siteHistoryStores.has(key)) {
            const store = new HistoryStore(path.join(config.DATA_DIR, `history-${safeSiteId(key)}.json`));
            store.load();
            siteHistoryStores.set(key, store);
        }
        return siteHistoryStores.get(key);
    };

    let predictor = null;
    if (config.MODEL.ENABLED) {
        predictor = Predictor.load(path.join(config.DATA_DIR, 'model.json'), {
            targetMultiplier: strategyConfig.targetMultiplier,
            minSampleSize: config.MODEL.MIN_SAMPLE_SIZE,
            minEntryProbability: config.MODEL.MIN_ENTRY_PROBABILITY,
            maxEntryProbability: config.MODEL.MAX_ENTRY_PROBABILITY,
            coldStreakLimit: config.MODEL.COLD_STREAK_LIMIT,
            coldRecoveryCount: config.MODEL.COLD_RECOVERY_COUNT,
            recencyHalfLife: config.MODEL.RECENCY_HALF_LIFE,
            recentWindow: config.MODEL.RECENT_WINDOW,
            wilsonCushion: config.MODEL.WILSON_CUSHION
        });
        predictor.setHistory(historyStore.values);
    }

    let patterns = null;
    if (config.PATTERN.ENABLED) {
        patterns = PatternDetector.load(path.join(config.DATA_DIR, 'patterns.json'), {
            lengths: config.PATTERN.LENGTHS,
            minSupport: config.PATTERN.MIN_SUPPORT,
            bins: config.PATTERN.BINS,
            targetMultiplier: strategyConfig.targetMultiplier
        });
        patterns.rebuildStream(historyStore.values);
    }

    const bankroll = Bankroll.load(path.join(config.DATA_DIR, 'bankroll.json'), {
        sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
        dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
        maxStakeFraction: config.RISK.MAX_STAKE_FRACTION,
        microStakeFraction: config.RISK.MICRO_STAKE_FRACTION,
        minStake: strategyConfig.minBet
    });
    if (config.MODE.PAPER) {
        // Paper mode simulates against the strategy's assumed capital —
        // otherwise a real balance below the min stake silently blocks every
        // simulated bet and the engine ledger stays empty forever.
        const paperCapital = config.MODE.PAPER_BANKROLL > 0
            ? config.MODE.PAPER_BANKROLL : strategyConfig.initialBet * 100;
        bankroll.setPaperReference(paperCapital);
    }

    const strategy = new BettingStrategy(strategyConfig);
    brain = new Brain({ config, strategy, predictor, patterns, bankroll });

    logger.info(
        `Memory loaded: ${roundsLoaded} rounds (legacy shared archive) | ` +
        `patterns known: ${patterns ? patterns.patterns.size : 0} | tier: ${brain.tier} ` +
        `(each site bootstraps its own engine on launch)`
    );

    // ---- Per-site engines -------------------------------------------------
    // Separate Aviator instances per bookmaker => each site owns its own
    // memory, predictor, pattern miner and brain. The FIRST engine created
    // inherits the legacy shared archive as a starting prior; later engines
    // start clean and must warm up on their own game's rounds.
    // (engines/primaryEngine are declared up top, before the dashboard.)
    const engineFor = (siteId) => {
        const key = String(siteId || 'unknown');
        if (engines.has(key)) return engines.get(key);
        const safe = safeSiteId(key);
        const store = siteHistoryFor(key);

        // ---- Per-site strategy + bankroll -------------------------------
        // Each bookmaker is an independent book, so each engine runs the
        // strategy selected FOR ITS SITE (data/site-strategies.json) and
        // sizes stakes from its OWN capital. Sites with no explicit choice
        // inherit the global default strategy picked at launch.
        const siteStrategyCfg = strategyConfigForSite(key);
        const siteStrategy = new BettingStrategy({ ...siteStrategyCfg });
        const siteBankroll = Bankroll.load(path.join(config.DATA_DIR, `bankroll-${safe}.json`), {
            sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
            dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
            maxStakeFraction: config.RISK.MAX_STAKE_FRACTION,
            microStakeFraction: config.RISK.MICRO_STAKE_FRACTION,
            minStake: siteStrategyCfg.minBet
        });
        const sitePaperCapital = config.MODE.PAPER_BANKROLL > 0
            ? config.MODE.PAPER_BANKROLL : siteStrategyCfg.initialBet * 100;
        if (config.MODE.PAPER) siteBankroll.setPaperReference(sitePaperCapital);
        logger.info(`Engine [${key}]: strategy ${siteStrategyCfg.name} ` +
            `(stake ${siteStrategyCfg.initialBet}, target ${siteStrategyCfg.adaptiveTarget ? 'model-driven' : `${siteStrategyCfg.targetMultiplier}x`}, ` +
            `${config.MODE.PAPER ? `paper capital ${sitePaperCapital}` : 'live sizing from real balance'})`);

        if (store.size() === 0 && !primaryEngine && historyStore.size() > 0) {
            historyStore.values.forEach((v) => store.append(v, { force: true }));
            logger.info(
                `Engine [${key}]: inherited ${store.size()} rounds from the legacy archive as a starting prior`
            );
        }

        let sitePredictor = null;
        if (config.MODEL.ENABLED) {
            sitePredictor = Predictor.load(path.join(config.DATA_DIR, `model-${safe}.json`), {
                targetMultiplier: siteStrategyCfg.targetMultiplier,
                minSampleSize: config.MODEL.MIN_SAMPLE_SIZE,
                minEntryProbability: config.MODEL.MIN_ENTRY_PROBABILITY,
                maxEntryProbability: config.MODEL.MAX_ENTRY_PROBABILITY,
                coldStreakLimit: config.MODEL.COLD_STREAK_LIMIT,
                coldRecoveryCount: config.MODEL.COLD_RECOVERY_COUNT,
                recencyHalfLife: config.MODEL.RECENCY_HALF_LIFE,
                recentWindow: config.MODEL.RECENT_WINDOW,
                wilsonCushion: config.MODEL.WILSON_CUSHION
            });
            sitePredictor.setHistory(store.values);
        }

        let sitePatterns = null;
        if (config.PATTERN.ENABLED) {
            sitePatterns = PatternDetector.load(path.join(config.DATA_DIR, `patterns-${safe}.json`), {
                lengths: config.PATTERN.LENGTHS,
                minSupport: config.PATTERN.MIN_SUPPORT,
                bins: config.PATTERN.BINS,
                targetMultiplier: siteStrategyCfg.targetMultiplier
            });
            sitePatterns.rebuildStream(store.values);
        }

        // Intelligence upgrade #1: adaptive probability self-repair. Studies
        // how this site's predictions actually settle and corrects the model's
        // confidence; persists across restarts in data/recalibration-<site>.json.
        const siteRecalibrator = new Recalibrator({
            file: path.join(config.DATA_DIR, `recalibration-${safe}.json`),
            minSettled: 100
        });
        siteRecalibrator.load();

        // ---- Phase-3 feature model (review #7: live model consumption) ----
        // The model verdict is the OUT-OF-SAMPLE judgment written by
        // scripts/train-model.js. Only a DEPLOY verdict loads a model into the
        // Brain; NO_SIGNAL and INSUFFICIENT_DATA keep the engine discipline-only.
        // The verdict file is the audit trail — it records WHY we bet or don't.
        // ---- Phase-3 feature model (reviews #7-#8: live model consumption) ----
        // The verdict is the OUT-OF-SAMPLE judgment written by
        // scripts/train-model.js. Only a DEPLOY verdict loads a model into the
        // Brain; NO_SIGNAL / INSUFFICIENT_DATA keep the engine discipline-only.
        // Lifecycle: a verdict is only trusted on data like what it was trained
        // on. Once the log grows by MODEL.RETRAIN_AFTER_ROUNDS beyond the
        // training corpus, the verdict is STALE and the model is automatically
        // re-trained + re-validated on the fresh data before anything loads.
        let modelVerdict = readModelVerdict(config.DATA_DIR, key);
        if (modelVerdict) {
            const logFile = path.join(config.DATA_DIR, `predictions-${safe}.jsonl`);
            const currentRows = fs.existsSync(logFile)
                ? rowsForSite(new PredictionLogger(logFile).readAll(), key).length : 0;
            // Verdicts written before the lifecycle metadata existed are
            // automatically re-validated once (their models lack feature
            // version + target-safety guarantees anyway).
            const fresh = Number.isFinite(modelVerdict.rowsAtTraining)
                ? modelStaleness(modelVerdict, currentRows, config.MODEL.RETRAIN_AFTER_ROUNDS)
                : { stale: true, newRows: 0, reason: 'verdict predates the lifecycle metadata — revalidating' };
            if (fresh.stale) {
                logger.info(`Feature model [${key}]: STALE — ${fresh.reason}. Auto-revalidating on the fresh data now...`);
                const retrained = trainModelForSite(key);
                if (retrained && !retrained.error) {
                    modelVerdict = readModelVerdict(config.DATA_DIR, key) || modelVerdict;
                    logger.info(`Feature model [${key}]: fresh verdict ${modelVerdict.verdict} (${modelVerdict.reason})`);
                } else {
                    modelVerdict = { ...modelVerdict, stale: true };
                    logger.warn(`Feature model [${key}]: revalidation failed (${retrained ? retrained.error : 'unknown'}) — stale model parked, discipline-only gates in force`);
                }
            }
        }
        let siteFeatureModel = null;
        if (modelVerdict && modelVerdict.verdict === 'DEPLOY' && !modelVerdict.stale) {
            siteFeatureModel = loadFeatureModel(config.DATA_DIR, key);
            // Target-safe + version-safe: a model is only usable if it was
            // trained on the CURRENT feature schema for a known target.
            if (siteFeatureModel && (!siteFeatureModel.meta ||
                !Number.isFinite(siteFeatureModel.meta.target) ||
                (Number.isFinite(siteFeatureModel.meta.featureVersion) &&
                 siteFeatureModel.meta.featureVersion !== FEATURE_VERSION))) {
                logger.warn(`Feature model [${key}]: metadata missing/incompatible with feature schema v${FEATURE_VERSION} — parked, discipline-only gates in force`);
                siteFeatureModel = null;
            } else if (siteFeatureModel) {
                logger.info(`Feature model [${key}]: DEPLOYED @${siteFeatureModel.meta.target}x — calibrated model probabilities drive the entry gate ` +
                    `(OOS Brier skill ${modelVerdict.brierSkill} vs best simple null, model-approved hit rate ${modelVerdict.entryHitRate}, EV/bet ${modelVerdict.evPerBet})`);
            }
        } else if (modelVerdict && modelVerdict.verdict) {
            logger.info(`Feature model [${key}]: ${modelVerdict.verdict}${modelVerdict.stale ? ' (STALE — parked)' : ''} (${modelVerdict.reason}) — discipline-only gates remain in force`);
        } else {
            logger.info(`Feature model [${key}]: no training verdict yet — run "npm run train:model" after observation grows`);
        }
        // Tournament audit trail: "npm run tournament" pits every model family
        // against each other out-of-sample and writes data/tournament-verdict-<site>.json.
        // Its winner (if any) is deployed THROUGH the normal model-verdict path above;
        // here we just surface the last tournament result so the startup log is complete.
        const tourVerdict = readTournamentVerdict(config.DATA_DIR, key);
        if (tourVerdict && tourVerdict.verdict) {
            logger.info(`Model tournament [${key}]: last run → ${tourVerdict.verdict}${tourVerdict.winner ? ` (winner: ${tourVerdict.winner})` : ''} — ${tourVerdict.reason || ''}`.trim());
        }

        const siteLifecycle = new SignalLifecycle(key);
        const activeSignals = siteLifecycle.getActiveSignals();
        if (activeSignals.length > 0) {
            logger.info(`Signal Lifecycle [${key}]: ${activeSignals.length} active hypothesis signal(s) loaded (${activeSignals.map((s) => `${s.name} [${s.status}]`).join(', ')})`);
        }

        let engineRef = null; // lets the brain read this engine's live verdict
        const siteBrain = new Brain({
            config, strategy: siteStrategy, predictor: sitePredictor, patterns: sitePatterns, bankroll: siteBankroll,
            recalibrator: siteRecalibrator,
            featureModel: siteFeatureModel,
            modelVerdict: modelVerdict || null,
            signalLifecycle: siteLifecycle,
            signal: {
                policy: config.MODEL.SIGNAL_POLICY,
                getVerdict: () => (engineRef ? engineRef.signalVerdict : null)
            }
        });
        const engine = {
            siteId: key,
            store,
            predictor: sitePredictor,
            patterns: sitePatterns,
            brain: siteBrain,
            signalLifecycle: siteLifecycle,
            // Per-site strategy + bankroll handles (dashboard strategy switch
            // hot-swaps these without touching the OTHER sites' books).
            strategy: siteStrategy,
            strategyConfig: { ...siteStrategyCfg },
            bankroll: siteBankroll,
            paperCapital: sitePaperCapital,
            // Measurement layer: every prediction is recorded and settled so
            // calibration and walk-forward validation have real data.
            predictionLog: new PredictionLogger(path.join(config.DATA_DIR, `predictions-${safe}.jsonl`)),
            calibration: new CalibrationTracker(),
            recalibrator: siteRecalibrator,
            // Phase-3 audit trail: the out-of-sample model verdict that decided
            // whether a trained feature model is driving entries (DEPLOY) or the
            // engine is discipline-only (NO_SIGNAL / INSUFFICIENT_DATA).
            modelVerdict: modelVerdict || null,
            pendingPrediction: null,
            // Profit/loss books (Profits panel), all persistent:
            //  baseline  — paper sim betting EVERY round at the strategy stake
            //  paperEng  — paper trades the engine's gates actually approved
            //  live      — real-money trades once LIVE mode is on
            paperBaseline: null,
            paperEngine: null,
            liveLedger: null
        };
        engine.paperBaseline = new PaperLedger(path.join(config.DATA_DIR, `paper-baseline-${safe}.json`), {
            kind: 'sim',
            capital: sitePaperCapital,
            stake: siteStrategyCfg.initialBet,
            target: siteStrategyCfg.targetMultiplier
        });
        engine.paperBaseline.load();
        engine.paperEngine = new PaperLedger(path.join(config.DATA_DIR, `paper-engine-${safe}.json`), { kind: 'log' });
        engine.paperEngine.load();
        engine.liveLedger = new PaperLedger(path.join(config.DATA_DIR, `live-${safe}.json`), { kind: 'log' });
        engine.liveLedger.load();
        engineRef = engine;

        // ---- Live signal validation: the walk-forward verdict is part of
        // the engine, not just a report. Recomputed whenever an engine boots
        // with enough rounds; persisted for other tools and restarts. ----
        engine.signalVerdict = readSignalVerdict(config.DATA_DIR, key);
        if (store.size() >= 400) {
            try {
                const report = runSignalValidation(store.values, { target: siteStrategyCfg.targetMultiplier });
                if (!report.error) {
                    writeSignalVerdict(config.DATA_DIR, key, report);
                    engine.signalVerdict = { ...report, ts: Date.now() };
                    logger.info(`Signal validation [${key}]: ${report.verdict}`);
                }
            } catch (error) {
                logger.debug(`Signal validation skipped [${key}]: ${error.message}`);
            }
        } else if (engine.signalVerdict) {
            logger.info(`Signal validation [${key}]: using stored verdict (${engine.signalVerdict.verdict})`);
        }

        engines.set(key, engine);

        if (!primaryEngine) {
            primaryEngine = engine;
            brain = siteBrain; // global brain follows the primary site from now on
        }
        logger.info(
            `Engine [${key}]: ready — ${store.size()} rounds in memory | ` +
            `${sitePatterns ? sitePatterns.patterns.size : 0} patterns | tier: ${siteBrain.tier}`
        );
        if (engine.predictor) {
            const p = engine.predictor;
            const prob = p.blendedProbability(p.targetMultiplier);
            logger.info(
                `Engine [${key}] entry gate: confidence ${prob === null ? 'n/a' : prob.toFixed(2)} vs ` +
                `required ${p.entryProbability.toFixed(2)} (baseline ${p.baseEntryProbability.toFixed(2)}) | ` +
                `volatility recent ${p.recentVolatility()?.toFixed(1)} vs long-run ${p.volatility()?.toFixed(1)}` +
                (p.entryProbability > p.baseEntryProbability
                    ? ' — entry gate is TIGHTENED by past losses; it auto-relaxes if the engine stays silent'
                    : '')
            );
        }
        return engine;
    };

    // Measurement hook: settle the prediction that was in force for the round
    // that just ended, then snapshot the engine's prediction for the NEXT
    // round into the permanent log. Runs in every mode (paper included) —
    // observing costs nothing and every settled prediction is evidence.
    const settleAndPredict = (engine, crash) => {
        if (!engine) return;
        // The ENGINE'S target (per-site strategy) — never the global default,
        // or a 2x site would log/settle predictions against a 1.3x question.
        const target = engine.strategy.targetMultiplier;
        try {
            const pending = engine.pendingPrediction;
            if (pending && Number.isFinite(pending.prob)) {
                const won = crash >= pending.target;
                // Calibration bookkeeping measures the probability that was
                // ACTUALLY shipped for this round (feature-model prob when a
                // model is driving, statistical prob otherwise).
                engine.calibration.record(pending.prob, won ? 1 : 0);
                // The engine learning from its own track record: every settled
                // prediction refines the confidence-correction map. The
                // recalibrator corrects the STATISTICAL estimator only — feed
                // it the raw statistical probability even when a feature model
                // made the decision (mixing sources would corrupt the map).
                if (engine.recalibrator) {
                    const recalProb = Number.isFinite(pending.rawProb) ? pending.rawProb : pending.prob;
                    engine.recalibrator.update(recalProb, won ? 1 : 0);
                    if (engine.recalibrator.total % 25 === 0) engine.recalibrator.save();
                }
                engine.predictionLog.logOutcome({
                    predictionId: pending.predictionId || null,
                    roundId: pending.roundId || null,
                    site: engine.siteId, target: pending.target,
                    prob: pending.prob, crash, won,
                    rawProb: Number.isFinite(pending.rawProb) ? pending.rawProb : null,
                    probSource: pending.probSource || 'statistical'
                });
            }
            let prob = null;               // probability that DRIVES the decision
            let rawProb = null;            // statistical estimator output
            let featureModelProb = null;   // deployed model output (calibrated)
            let threshold = null;
            let allowed = false;
            let regime = '';
            if (engine.predictor) {
                rawProb = engine.predictor.blendedProbability(target);
                prob = rawProb;
                threshold = engine.predictor.entryProbability;
                const gate = engine.predictor.shouldAllowBet();
                allowed = !!gate.allowed;
                regime = typeof engine.predictor.regime === 'function' ? engine.predictor.regime() : '';
            }
            // Review #8: log BOTH probabilities. When a deployed feature model
            // drives the entry gate, the research log must say so — otherwise
            // post-trade analysis cannot answer "which component caused this
            // bet?". Same target/version guard the Brain applies.
            let probSource = 'statistical';
            let modelTarget = null;
            const activeModel = engine.brain && engine.brain.featureModelFor
                ? engine.brain.featureModelFor(target) : null;
            if (activeModel) {
                const fmProb = activeModel.predict(extractFeatures(engine.store.values, target));
                if (Number.isFinite(fmProb)) {
                    featureModelProb = fmProb;
                    prob = fmProb;
                    probSource = 'feature-model';
                    modelTarget = activeModel.meta.target;
                }
            }
            const predictionId = `${engine.siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            const roundId = engine.store ? engine.store.size() : 0;
            engine.pendingPrediction = {
                predictionId, roundId,
                target, prob, threshold, allowed, tier: engine.brain.tier, regime,
                rawProb, featureModelProb, probSource, modelTarget
            };
            // Snapshot the correction map in force NOW, so the audit scores
            // the STATISTICAL probability for this round (the recalibrator's
            // training source, whether or not a model made the decision).
            if (engine.recalibrator && Number.isFinite(rawProb)) engine.recalibrator.notePending(rawProb);
            engine.predictionLog.logPrediction({
                predictionId, roundId,
                site: engine.siteId, target, prob, threshold, allowed,
                tier: engine.brain.tier, regime,
                rawProb, featureModelProb, probSource, modelTarget,
                featureVersion: FEATURE_VERSION,
                // Auditability (review #9): every record says WHICH model
                // family produced the deployed probability, so later analysis
                // can attribute results to a component, not just to "the bot".
                modelSource: engine.modelVerdict ? (engine.modelVerdict.source || 'train-model') : null,
                modelWinner: engine.modelVerdict && engine.modelVerdict.winner ? engine.modelVerdict.winner : null,
                // Feature snapshot of the stream state — raw material for
                // future error analysis (which, if any, feature carries signal).
                features: extractFeatures(engine.store.values, target)
            });
        } catch (error) {
            logger.debug(`prediction log skipped: ${error.message}`);
        }
    };

    // ---- Profits & losses (paper simulation + live trades) ----
    profitsSnapshot = () => ({
        paperMode,
        sites: [...engines.values()].map((e) => ({
            site: e.siteId,
            baseline: e.paperBaseline ? e.paperBaseline.stats() : null,
            engine: e.paperEngine ? e.paperEngine.stats() : null,
            live: e.liveLedger ? e.liveLedger.stats() : null
        }))
    });
    const emitProfits = () => {
        if (dashboard) dashboard.io.emit('profits', profitsSnapshot());
    };
    // Reset the paper books (Profits panel "Reset paper simulation" button,
    // and strategy switches). Hoisted on purpose: the dashboard handlers
    // registered earlier in main() call this before its source position runs.
    function resetPaperLedgers(siteId = null) {
        for (const e of engines.values()) {
            if (siteId && e.siteId !== siteId) continue;
            // Each engine resets on its OWN strategy's capital/stake/target —
            // a per-site strategy switch must not resize the other sites.
            const cfg = e.strategyConfig || strategyConfig;
            if (!cfg) continue;
            const capital = config.MODE.PAPER_BANKROLL > 0
                ? config.MODE.PAPER_BANKROLL
                : cfg.initialBet * 100;
            if (e.paperBaseline) {
                e.paperBaseline.reset(capital, cfg.initialBet, cfg.targetMultiplier);
                logger.info(`Paper baseline [${e.siteId}] reset to ${capital} (stake ${cfg.initialBet} @ ${cfg.targetMultiplier}x)`);
            }
            if (e.paperEngine) {
                e.paperEngine.reset(0, cfg.initialBet, cfg.targetMultiplier);
                logger.info(`Paper engine ledger [${e.siteId}] reset (stake ${cfg.initialBet} @ ${cfg.targetMultiplier}x)`);
            }
        }
        if (dashboard) dashboard.io.emit('profits', profitsSnapshot());
    }

    // Round-by-round + trade CSV logs (site/account tagged per row)
    const csvRounds = new CsvLog(path.join(config.DATA_DIR, 'rounds.csv'), [
        'ts', 'mode', 'site', 'account', 'roundId', 'crash', 'betPlaced', 'stake',
        'outcome', 'pnl', 'confidence', 'pattern', 'tier', 'regime'
    ]);
    const csvTrades = new CsvLog(path.join(config.DATA_DIR, 'trades.csv'), [
        'ts', 'mode', 'site', 'account', 'roundId', 'stake', 'target', 'multiplier', 'pnl', 'won', 'tier'
    ]);

    const database = new Database(config);
    database.connect();

    // ---- Monitor attachment (any page of any session that hosts the game) ----
    const attachMonitor = async (candidate, session) => {
        if (!candidate || session.monitor) return;
        // Never attach on the home page: its teaser widgets/odds grids can
        // look like the round strip, but you can't watch or bet from there.
        try {
            if (isSiteHomeUrl(candidate.url(), session.site)) return;
        } catch (error) { return; /* page closing */ }
        const selectors = selectorsFor(session.site);
        try {
            if (!(await FrameHelper.findGameMarker(candidate, selectors.BUBBLE_MULTIPLIER))) return;
        } catch (error) {
            return;
        }
        try {
            candidate.on('error', (error) => logger.error(`Game page crashed: ${error.message}`));
            candidate.on('pageerror', (error) => logger.error(`Game page JS error: ${error.message}`));
        } catch (error) { /* page may already be closing */ }

        const engine = engineFor(session.site.id);
        const monitor = new GameMonitor(candidate, config, engine.brain, {
            historyStore: engine.store,
            csvRounds,
            selectors,
            site: session.site.id,
            account: session.account.label,
            currency: session.site.currency
        });
        session.monitor = monitor;
        monitor.betManager.paperMode = paperMode; // honor the dashboard mode switch

        // One-shot: seed long-term memory from the visible history strip
        // (the payout bubbles the game page already shows).
        monitor.on('seedHistory', (values) => {
            if (!Array.isArray(values) || values.length === 0) return;
            const engine = engineFor(monitor.site);
            // Per-site memory always takes the strip (force: seeds arrive as a
            // batch where adjacent identical values are legitimate).
            values.forEach((v) => engine.store.append(v, { force: true }));
            if (engine.predictor) engine.predictor.setHistory(engine.store.values);
            if (engine.patterns) engine.patterns.rebuildStream(engine.store.values);
            logger.info(
                `Memory seeded with ${values.length} rounds from the on-screen history strip ` +
                `[${monitor.site}: total ${engine.store.size()}]`
            );
        });

        monitor.on('roundTrace', (trace) => {
            const safe = safeSiteId(monitor.site);
            const traceFile = path.join(config.DATA_DIR, `traces-${safe}.jsonl`);
            try {
                fs.mkdirSync(config.DATA_DIR, { recursive: true });
                fs.appendFileSync(traceFile, `${JSON.stringify(trace)}\n`);
            } catch (error) { /* non-fatal */ }
        });

        monitor.on('roundEnded', (d) => {
            database.saveRound(d.crash);
            // The monitor already appended the round to this site's own store;
            // never feed other sites' streams into it.
            const engine = engineFor(monitor.site);
            settleAndPredict(engine, d.crash);
            if (paperMode && engine.paperBaseline) {
                const r = engine.paperBaseline.playRound(d.crash);
                if (r && r.skipped && engine.paperBaseline.skipped === 1) {
                    logger.warn(`Paper baseline [${monitor.site}]: simulated bankroll exhausted — press Reset on the Profits panel to restart the simulation`);
                }
            }
            emitProfits();
            if (d.brain) d.brain.site = monitor.site;
            if (dashboard) {
                dashboard.io.emit('newData', {
                    value: d.crash,
                    created_at: Date.now(),
                    predictedValue: d.nextPrediction
                });
                dashboard.io.emit('brain', d.brain);
            }
        });
        monitor.on('trade', (t) => {
            database.saveTrade(t);
            // P&L books: paper trades feed the engine ledger, LIVE trades the
            // real-money ledger (both shown on the Profits panel).
            const engine = engineFor(monitor.site);
            const ledger = monitor.mode() === 'paper' ? engine.paperEngine : engine.liveLedger;
            if (ledger) ledger.recordTrade({ stake: t.betAmount, pnl: t.won ? t.profit : t.loss, won: t.won });
            emitProfits();
            csvTrades.write({
                ts: new Date().toISOString(),
                mode: monitor.mode(),
                site: monitor.site,
                account: monitor.account,
                roundId: monitor.roundId,
                stake: t.betAmount,
                target: engine.strategy.targetMultiplier,
                multiplier: t.multiplier ?? '',
                pnl: t.won ? t.profit : t.loss,
                won: t.won ? 'yes' : 'no',
                tier: engine.brain.tier
            });
            if (dashboard) dashboard.io.emit('trade', t);
        });
        monitor.on('status', (s) => { if (dashboard) dashboard.io.emit('status', s); });
        monitor.on('tradingStopped', () => {
            logger.warn('Trading halted — monitoring continues');
            if (dashboard) dashboard.io.emit('tradingStopped', true);
        });
        monitor.on('needsRenavigation', async () => {
            if (session.site.gameUrl) {
                logger.info('Re-navigating game page to the Aviator URL...');
                await gotoSafe(candidate, session.site.gameUrl, 'Aviator (recovery)');
            }
        });

        try {
            monitor.startMonitoring();
        } catch (error) {
            logger.error(`Game monitor failed to start on ${session.site.name}: ${error.message}`);
            session.monitor = null;
            return;
        }
        session.widgetWarned = false;
        setSessionPhase(session, 'monitoring');
        logger.info(`Game monitor started on ${candidate.url()} [${session.site.name} / "${session.account.label}"]`);
    };

    // Watcher loop across ALL sessions (same-tab navigation, retries, pruning)
    let watcherLastError = '';
    const watcher = setInterval(async () => {
        try {
            for (const session of sessions.values()) {
                if (session.page.isClosed()) {
                    if (session.monitor) { session.monitor.stopMonitoring(); session.monitor = null; }
                    continue;
                }
                const pages = await session.browser.pages();
                for (const p of pages) {
                    if (!session.monitor) await attachMonitor(p, session);
                }
                // Explainable silence: page looks ready but the widget never
                // matched (preview overlay? PLAY button? blocked frame?).
                const waitingPhase = session.phase !== 'loginRequired' &&
                    session.phase !== 'navigating' && session.phase !== 'starting';
                if (!session.monitor && waitingPhase && !session.widgetWarned) {
                    if (!session.widgetWaitSince) session.widgetWaitSince = Date.now();
                    if (Date.now() - session.widgetWaitSince > 60000) {
                        session.widgetWarned = true;
                        logger.warn(
                            `${session.site.name}: game widget not found yet. If the page shows a ` +
                            'preview or PLAY button, press PLAY once — monitoring starts automatically. ' +
                            'Values in the dashboard update after each completed round (~10-20s each).'
                        );
                    }
                } else if (session.monitor) {
                    session.widgetWaitSince = 0;
                }
            }
        } catch (error) {
            // Was logger.debug — invisible failures here once hid a broken
            // monitor-attach loop. Warn once per distinct error instead.
            if (watcherLastError !== error.message) {
                watcherLastError = error.message;
                logger.warn(`Watcher loop problem: ${error.message}`);
            }
        }
    }, 3000);

    // ---- Initial session: from CLI selection or dashboard LAUNCH ----
    activeSite = selection.site;
    accounts.setLastActive(activeSite.id, selection.account.id);
    logger.info(`Session: ${activeSite.name} / "${selection.account.label}" (profile ${selection.account.id})`);
    let initialSession;
    try {
        initialSession = await launchSession(selection.account, activeSite);
    } catch (error) {
        // Keep the dashboard up so the error stays visible in the UI,
        // then let the process exit for supervisor restart.
        emitSiteStatus('error', { message: `Browser failed to start: ${error.message.split('\n')[0]} — see the bot window for the fix` });
        logger.error('Cannot continue without a browser session — exiting. Read the message above for the fix.');
        throw error;
    }
    await navigateSessionToGame(initialSession);

    // Keep the dashboard's session view fresh even between phase changes
    const sessionsHeartbeat = setInterval(emitSessions, 10000);

    // ---- Graceful shutdown ----
    const shutdown = async (reason) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`Shutting down (${reason})...`);
        clearInterval(watcher);
        clearInterval(sessionsHeartbeat);
        for (const session of sessions.values()) {
            if (session.monitor) session.monitor.stopMonitoring();
            try { await session.browser.close(); } catch (error) { /* already closed */ }
        }
        sessions.clear();
        for (const engine of engines.values()) {
            if (engine.predictor) engine.predictor.save();
            if (engine.patterns) engine.patterns.save();
            logger.info(`Calibration [${engine.siteId}]: ${engine.calibration.summary()} (see predictions-${safeSiteId(engine.siteId)}.jsonl)`);
            if (engine.recalibrator) {
                engine.recalibrator.save();
                const r = engine.recalibrator.snapshot();
                logger.info(
                    `Self-calibration [${engine.siteId}]: ${r.settled}/${r.minSettled} settled — ` +
                    (r.ready
                        ? `active${r.brierRaw !== null ? ` (Brier raw ${r.brierRaw} vs corrected ${r.brierAdjusted}${r.helping ? ', correction is helping' : ''})` : ''}`
                        : 'learning (pass-through until enough evidence)')
                );
            }
        }
        if (!primaryEngine) {
            if (predictor) predictor.save();
            if (patterns) patterns.save();
        }
        if (bankroll) bankroll.save();
        database.disconnect();
        if (dashboard) { try { dashboard.server.close(); } catch (error) { /* ignore */ } }
        rl.close();
        logger.info('Cleanup completed — memory, model, patterns and bankroll saved');
        process.exit(0);
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => shutdown(signal));
    }
    setTimeout(() => shutdown('run duration elapsed'), config.NAVIGATION.RUN_DURATION);

    logger.info('Bot initialization completed — watching for the game page');
}

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.stack || error.message}`);
    process.exit(1);
});

main().catch((error) => {
    logger.error(`Failed to start bot: ${error.stack || error.message}`);
    logger.error('The dashboard (if it started) still shows this error — read the lines above for the fix.');
    // Give the dashboard a moment to deliver the fatal state to any open UI.
    setTimeout(() => process.exit(1), 1500);
});
