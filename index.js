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
const { getSite, listSites, selectorsFor } = require('./util/sites');
const { startDashboard } = require('./server');

// ---------------------------------------------------------------------------
// Global runtime state
// ---------------------------------------------------------------------------
const accounts = new AccountsManager(config.DATA_DIR);
const sessions = new Map(); // accountId -> { browser, page, account, site }
let activeSite = getSite(config.SITE_ID);
let dashboard = null;
let loginWaiter = null; // {resolve} while waiting for the user to log in
let shuttingDown = false;   // global: graceful shutdown in progress
let switchInProgress = false; // global: site/account switch in progress

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
 * Waits for the user to finish logging in. Two ways to confirm:
 *  - click "I'm logged in — continue" on the dashboard
 *  - press ENTER in the terminal (when running in a TTY)
 */
function waitForLoginConfirmation(session) {
    const site = session.site;
    return new Promise((resolve) => {
        loginWaiter = {
            account: session.account,
            resolve: () => {
                accounts.touchLogin(session.account.id);
                logger.info(`Login confirmed for "${session.account.label}" — profile remembered`);
                loginWaiter = null;
                resolve();
            }
        };
        logger.warn(
            `>> LOG IN to ${site.name} in the browser window now ` +
            `(login page: ${site.loginUrl || site.baseUrl}). ` +
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

async function navigateSessionToGame(session) {
    const { page, site } = session;
    await gotoSafe(page, site.baseUrl, `${site.name} home`);

    if (site.loginFlow === 'manual') {
        setSessionPhase(session, 'loginRequired');
        emitSiteStatus('loginRequired', { accountLabel: session.account.label });
        await waitForLoginConfirmation(session);
    }

    // Session was cancelled (another switch happened) or closed while we
    // were waiting for the login confirmation — stop navigating it.
    if (session.cancelled || session.page.isClosed()) {
        logger.warn(`Session for "${session.account.label}" cancelled during login wait`);
        return;
    }

    if (site.gameUrl) {
        setSessionPhase(session, 'navigating');
        await gotoSafe(page, site.gameUrl, `${site.name} Aviator`);
        setSessionPhase(session, 'active');
        emitSiteStatus('active', { accountLabel: session.account.label });
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

    const strategyConfig = await selectStrategy();
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
    const brain = new Brain({ config, strategy, predictor, patterns, bankroll });

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

    // ---- Dashboard + site-switch controls ----
    if (config.DASHBOARD.ENABLED) {
        try {
            dashboard = await startDashboard(config.DASHBOARD.PORT, logger, {
                accounts,
                getActiveSite: () => ({ id: activeSite.id, name: activeSite.name, currency: activeSite.currency }),
                getSessions: sessionsSnapshot
            });
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
            });
        } catch (error) {
            logger.error(`Dashboard failed to start: ${error.message}`);
        }
    }

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

        monitor.startMonitoring();
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
            }
        } catch (error) {
            logger.debug(`Watcher loop: ${error.message}`);
        }
    }, 3000);

    // ---- Initial session: CLI site/account selection (or last-active) ----
    const selection = await selectSiteAndAccount();
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
