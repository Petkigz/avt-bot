require('dotenv').config();

const path = require('path');
const puppeteer = require('puppeteer');
const readline = require('readline');
const config = require('./util/config');
const logger = require('./util/logger');
const sleep = require('./util/sleep');
const FrameHelper = require('./util/frameHelper');
const GameMonitor = require('./game/gameMonitor');
const BettingStrategy = require('./game/strategies');
const Database = require('./database/database');
const HistoryStore = require('./game/historyStore');
const Predictor = require('./game/predictor');
const PatternDetector = require('./game/patternDetector');
const Bankroll = require('./game/bankroll');
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

async function launchSession(account, site) {
    const launchOptions = {
        headless: config.BROWSER.HEADLESS,
        defaultViewport: null,
        args: ['--start-maximized'],
        // Per-account persistent profile: log in once per account, stays logged in.
        userDataDir: accounts.profileDir(account.id)
    };
    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.NAVIGATION.TIMEOUT);

    const session = { browser, page, account, site, monitor: null, phase: 'launching', rateWindow: [] };
    sessions.set(account.id, session);
    emitSessions();

    browser.on('disconnected', () => {
        sessions.delete(account.id);
        emitSessions();
        logger.warn(`Browser session closed for account "${account.label}" (${site.name})`);
        // Only treat "no sessions left" as fatal when it is unexpected —
        // during shutdown or a site switch we close browsers on purpose.
        if (sessions.size === 0 && !shuttingDown && !switchInProgress) {
            logger.error('No browser sessions left — exiting for supervisor restart');
            process.exit(1);
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
async function waitForGameWidget(page, site, timeoutMs = 12000) {
    const selectors = selectorsFor(site);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            if (!page.isClosed() && await FrameHelper.hasSelector(page, selectors.BUBBLE_MULTIPLIER)) return true;
        } catch (error) { /* page busy */ }
        await sleep(1500);
    }
    return false;
}

async function navigateSessionToGame(session) {
    const { page, site } = session;
    await gotoSafe(page, site.baseUrl, `${site.name} home`);

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
    // re-navigate — that would throw away the working page.
    if (await FrameHelper.hasSelector(page, selectorsFor(site).BUBBLE_MULTIPLIER).catch(() => false)) {
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
        if (await waitForGameWidget(page, site, 12000)) {
            setSessionPhase(session, 'active');
            emitSiteStatus('active', { accountLabel: session.account.label });
        } else {
            logger.warn(
                `${site.name}: the Aviator deep link did not show the game widget ` +
                `(${site.gameUrl}). Open Aviator from the site menu — the watcher will find it.`
            );
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
    let brain = null;          // assigned after strategy selection (handlers are null-safe)
    let strategyConfig = null;
    let pendingStrategyName = null; // strategy picked in the UI before launch
    let paperMode = config.MODE.PAPER; // live-switchable from the dashboard
    let controlState = () => ({
        awaitingLaunch: awaitingUiLaunch,
        paused: brain ? brain.paused : false,
        strategy: strategyConfig ? strategyConfig.name : pendingStrategyName,
        mode: paperMode ? 'paper' : 'live'
    });
    const emitControlState = () => { if (dashboard) dashboard.io.emit('controlState', controlState()); };

    if (config.DASHBOARD.ENABLED) {
        try {
            const dashboardDeps = {
                accounts,
                getActiveSite: () => ({ id: activeSite.id, name: activeSite.name, currency: activeSite.currency }),
                getSessions: sessionsSnapshot,
                getControlState: controlState,
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
                setStrategy: (id) => {
                    const preset = config.BETTING_STRATEGIES[String(id || '').toUpperCase()];
                    if (!preset) throw new Error(`unknown strategy "${id}"`);
                    if (brain) {
                        // Hot-swap: Brain reads this.strategy live on every round.
                        brain.strategy = new BettingStrategy({ ...preset });
                        logger.warn(`Strategy switched to ${preset.name} from the dashboard (progression reset)`);
                    } else {
                        pendingStrategyName = preset.name;
                        logger.info(`Strategy ${preset.name} selected from the dashboard — will be used for the next launch`);
                    }
                    emitControlState();
                    return { name: preset.name };
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
                    const preset = config.BETTING_STRATEGIES[
                        String(p.strategy || pendingStrategyName || 'MICRO').toUpperCase()
                    ] || config.BETTING_STRATEGIES.MICRO;
                    logger.info(`Launch requested from dashboard: ${site.name} / "${account.label}" / ${preset.name}`);
                    uiLaunchWaiter.resolve({ site, account, strategyConfig: { ...preset } });
                });
                socket.on('pauseBetting', () => {
                    if (brain) { brain.paused = true; logger.warn('Betting PAUSED from the dashboard'); emitControlState(); }
                });
                socket.on('resumeBetting', () => {
                    if (brain) { brain.paused = false; logger.info('Betting RESUMED from the dashboard'); emitControlState(); }
                });
                // Strategy hot-swap (running session) or pre-launch selection
                socket.on('setStrategy', ({ strategy } = {}) => {
                    try {
                        dashboardDeps.setStrategy(strategy);
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
                    FrameHelper.hasSelector(s.page, selectors.BUBBLE_MULTIPLIER)
                        .catch(() => false)
                        .then(async (alreadyOpen) => {
                            if (alreadyOpen) {
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
                            if (await waitForGameWidget(s.page, s.site, 12000)) {
                                emitSiteStatus('active', { accountLabel: s.account.label });
                            } else {
                                logger.warn(`${s.site.name}: deep link did not show the game — open Aviator from the menu; the watcher will find it`);
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
        emitControlState();
    } else {
        strategyConfig = await selectStrategy();
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
    //      Aviator is ONE global game feed, so rounds from any site are valid) ----
    const historyStore = new HistoryStore(path.join(config.DATA_DIR, 'history.json'));
    const roundsLoaded = historyStore.load();

    let predictor = null;
    if (config.MODEL.ENABLED) {
        predictor = Predictor.load(path.join(config.DATA_DIR, 'model.json'), {
            targetMultiplier: strategyConfig.targetMultiplier,
            minSampleSize: config.MODEL.MIN_SAMPLE_SIZE,
            minEntryProbability: config.MODEL.MIN_ENTRY_PROBABILITY,
            maxEntryProbability: config.MODEL.MAX_ENTRY_PROBABILITY,
            coldStreakLimit: config.MODEL.COLD_STREAK_LIMIT,
            coldRecoveryCount: config.MODEL.COLD_RECOVERY_COUNT
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

    const strategy = new BettingStrategy(strategyConfig);
    brain = new Brain({ config, strategy, predictor, patterns, bankroll });

    logger.info(
        `Memory loaded: ${roundsLoaded} rounds (cross-site) | ` +
        `patterns known: ${patterns ? patterns.patterns.size : 0} | tier: ${brain.tier} ` +
        `(bets start only after ${config.RISK.MIN_ROUNDS_OBSERVE} rounds of warm-up)`
    );

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
        const selectors = selectorsFor(session.site);
        try {
            if (!(await FrameHelper.hasSelector(candidate, selectors.BUBBLE_MULTIPLIER))) return;
        } catch (error) {
            return;
        }
        try {
            candidate.on('error', (error) => logger.error(`Game page crashed: ${error.message}`));
            candidate.on('pageerror', (error) => logger.error(`Game page JS error: ${error.message}`));
        } catch (error) { /* page may already be closing */ }

        const monitor = new GameMonitor(candidate, config, brain, {
            historyStore,
            csvRounds,
            selectors,
            site: session.site.id,
            account: session.account.label
        });
        session.monitor = monitor;
        monitor.betManager.paperMode = paperMode; // honor the dashboard mode switch

        // One-shot: seed long-term memory from the visible history strip
        // (the payout bubbles the game page already shows).
        monitor.on('seedHistory', (values) => {
            if (!Array.isArray(values) || values.length === 0) return;
            if (historyStore.size() >= 50) return; // memory already has its own rounds
            values.forEach((v) => historyStore.append(v));
            if (predictor) predictor.setHistory(historyStore.values);
            if (patterns) patterns.rebuildStream(historyStore.values);
            logger.info(
                `Memory seeded with ${values.length} rounds from the on-screen history strip ` +
                `(total ${historyStore.size()})`
            );
        });

        monitor.on('roundEnded', (d) => {
            database.saveRound(d.crash);
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
            csvTrades.write({
                ts: new Date().toISOString(),
                mode: monitor.mode(),
                site: monitor.site,
                account: monitor.account,
                roundId: monitor.roundId,
                stake: t.betAmount,
                target: strategyConfig.targetMultiplier,
                multiplier: t.multiplier ?? '',
                pnl: t.won ? t.profit : t.loss,
                won: t.won ? 'yes' : 'no',
                tier: brain.tier
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
            logger.debug(`Watcher loop: ${error.message}`);
        }
    }, 3000);

    // ---- Initial session: from CLI selection or dashboard LAUNCH ----
    activeSite = selection.site;
    accounts.setLastActive(activeSite.id, selection.account.id);
    logger.info(`Session: ${activeSite.name} / "${selection.account.label}" (profile ${selection.account.id})`);
    const initialSession = await launchSession(selection.account, activeSite);
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
        if (predictor) predictor.save();
        if (patterns) patterns.save();
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
    process.exit(1);
});
