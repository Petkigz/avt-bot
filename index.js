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
const { startDashboard } = require('./server');

// ---------------------------------------------------------------------------
// Interactive strategy selection
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function selectStrategy() {
    if (!process.stdin.isTTY) {
        logger.warn('No interactive terminal detected — defaulting to MODERATE strategy');
        return { ...config.BETTING_STRATEGIES.MODERATE };
    }

    console.log('\nAvailable Strategies (amounts are in SITE CURRENCY — UGX on BetPawa.ug):');
    console.log('1. Conservative (Lower risk, smaller profits)');
    console.log('2. Moderate (Balanced risk and reward)');
    console.log('3. Aggressive (Higher risk, larger potential profits)');
    console.log('4. Custom (Define your own parameters)\n');

    const choice = await askQuestion('Select strategy (1-4): ');
    switch (choice) {
        case '1': return { ...config.BETTING_STRATEGIES.CONSERVATIVE };
        case '2': return { ...config.BETTING_STRATEGIES.MODERATE };
        case '3': return { ...config.BETTING_STRATEGIES.AGGRESSIVE };
        case '4': return customStrategySetup();
        default:
            logger.warn('Invalid choice, using Moderate strategy');
            return { ...config.BETTING_STRATEGIES.MODERATE };
    }
}

async function customStrategySetup(attempt = 1) {
    if (attempt > 3) {
        logger.error('Too many invalid attempts — falling back to MODERATE strategy');
        return { ...config.BETTING_STRATEGIES.MODERATE };
    }
    console.log(`\nCustom strategy setup (attempt ${attempt}/3) — amounts in UGX on BetPawa.ug`);
    const askNum = async (label) => parseFloat(await askQuestion(label));

    const strategy = {
        name: 'CUSTOM',
        initialBet: await askNum('Initial bet amount (e.g. 1000): '),
        maxBet: await askNum('Maximum bet amount: '),
        minBet: await askNum('Minimum bet amount: '),
        targetMultiplier: await askNum('Target multiplier (e.g., 1.5): '),
        stopLoss: await askNum('Stop loss amount: '),
        takeProfit: await askNum('Take profit amount: '),
        martingaleMultiplier: await askNum('Martingale multiplier (e.g., 2): '),
        averageMultiplierThreshold: await askNum('Average multiplier threshold to trigger bets (e.g., 2): ')
    };

    const { ok, errors } = BettingStrategy.validate(strategy);
    if (!ok) {
        errors.forEach((e) => logger.warn(e));
        return customStrategySetup(attempt + 1);
    }
    return strategy;
}

// ---------------------------------------------------------------------------
// Browser automation
// ---------------------------------------------------------------------------
async function initializeBrowser() {
    const launchOptions = {
        headless: config.BROWSER.HEADLESS,
        defaultViewport: null,
        args: ['--start-maximized']
    };
    // Persistent profile -> your BetPawa login survives restarts.
    if (config.BROWSER.USER_DATA_DIR) {
        launchOptions.userDataDir = config.BROWSER.USER_DATA_DIR;
    }
    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.NAVIGATION.TIMEOUT);
    return { browser, page };
}

async function gotoSafe(page, url) {
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: config.NAVIGATION.TIMEOUT });
        return true;
    } catch (error) {
        logger.warn(`Navigation to ${url} did not reach networkidle2, continuing: ${error.message}`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.NAVIGATION.TIMEOUT });
            return true;
        } catch (error2) {
            logger.error(`Navigation to ${url} failed: ${error2.message}`);
            return false;
        }
    }
}

/**
 * BetPawa flow: open the site, let the user log in manually (once — the
 * session is kept in the persistent Chrome profile), then open the game.
 */
async function navigateToGame(page) {
    await gotoSafe(page, config.NAVIGATION.BASE_URL);

    if (config.LOGIN.MANUAL && process.stdin.isTTY) {
        await askQuestion(
            '\n>> Log in to BetPawa in the browser window (if not already logged in),\n' +
            '>> then press ENTER here to open the Aviator game...\n'
        );
    } else {
        logger.warn('MANUAL_LOGIN disabled or no TTY — assuming the saved profile is logged in');
    }

    await gotoSafe(page, config.NAVIGATION.GAME_URL);

    // Optional extra click steps (empty by default for BetPawa)
    for (const step of config.NAVIGATION_STEPS) {
        try {
            await page.waitForSelector(step.selector, {
                timeout: step.required ? config.NAVIGATION.TIMEOUT : 5000
            });
            await page.click(step.selector);
            logger.info(`Clicked ${step.name}`);
            await sleep(1000);
        } catch (error) {
            if (step.required) {
                logger.error(`Failed to click ${step.name}: ${error.message}`);
                throw error;
            }
            logger.warn(`Optional step "${step.name}" skipped (${error.message})`);
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    logger.info('Starting Aviator Bot (target: BetPawa Uganda)...');

    const strategyConfig = await selectStrategy();
    logger.info(
        `Strategy: ${strategyConfig.name} | initial bet ${strategyConfig.initialBet} | ` +
        `target ${strategyConfig.targetMultiplier}x | stop-loss ${strategyConfig.stopLoss} | ` +
        `take-profit ${strategyConfig.takeProfit}`
    );

    // ---- Memory + model (persisted across runs) ----
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
        logger.info(
            `Model ready: ${roundsLoaded} historical rounds loaded | ` +
            `P(crash >= ${strategyConfig.targetMultiplier}x) = ` +
            `${(predictor.probCrashAtLeast(strategyConfig.targetMultiplier) ?? 0).toFixed(2)} | ` +
            `entry threshold ${predictor.entryProbability.toFixed(2)} | regime: ${predictor.regime()}`
        );
    } else {
        logger.warn('Model disabled (MODEL_ENABLED=false) — betting on strategy rules only');
    }

    // Optional persistence (DATABASE_ENABLED=true in .env)
    const database = new Database(config);
    database.connect();

    // Live dashboard (serves /public over socket.io)
    let dashboard = null;
    if (config.DASHBOARD.ENABLED) {
        try {
            dashboard = await startDashboard(config.DASHBOARD.PORT, logger);
        } catch (error) {
            logger.error(`Dashboard failed to start: ${error.message}`);
        }
    }

    const { browser, page } = await initializeBrowser();
    logger.info('Browser initialized (persistent profile keeps your login between runs)');

    browser.on('disconnected', () => {
        logger.error('Browser disconnected unexpectedly — exiting for supervisor restart');
        process.exit(1);
    });

    // One monitor per game page, deduplicated.
    const monitors = new Map(); // page -> GameMonitor

    const attachMonitor = async (candidate) => {
        if (!candidate || monitors.has(candidate)) return;
        try {
            if (!(await FrameHelper.hasSelector(candidate, config.SELECTORS.GAME.BUBBLE_MULTIPLIER))) return;
        } catch (error) {
            return;
        }

        try {
            candidate.on('error', (error) => logger.error(`Game page crashed: ${error.message}`));
            candidate.on('pageerror', (error) => logger.error(`Game page JS error: ${error.message}`));
        } catch (error) { /* page may already be closing */ }

        // Fresh strategy instance per monitor so the SELECTED config is used.
        const monitor = new GameMonitor(candidate, config, { ...strategyConfig }, {
            predictor,
            historyStore
        });
        monitors.set(candidate, monitor);

        monitor.on('roundEnded', (d) => {
            database.saveRound(d.crash);
            if (dashboard) {
                dashboard.io.emit('newData', {
                    value: d.crash,
                    created_at: Date.now(),
                    predictedValue: d.nextPrediction
                });
                dashboard.io.emit('model', d.model);
            }
        });
        monitor.on('trade', (t) => {
            database.saveTrade(t);
            if (dashboard) dashboard.io.emit('trade', t);
        });
        monitor.on('status', (s) => {
            if (dashboard) dashboard.io.emit('status', s);
        });
        monitor.on('tradingStopped', () => {
            logger.warn('Trading halted — monitoring continues');
            if (dashboard) dashboard.io.emit('tradingStopped', true);
        });
        // Site-state recovery ladder level 2: bring the page back to the game.
        monitor.on('needsRenavigation', async () => {
            logger.info('Re-navigating game page to the Aviator URL...');
            await gotoSafe(candidate, config.NAVIGATION.GAME_URL);
        });

        monitor.startMonitoring();
        logger.info(`Game monitor started on ${candidate.url()}`);
    };

    // New tabs/pages — race-free (attachMonitor no-ops until game markup exists)
    browser.on('targetcreated', async (target) => {
        if (target.type() !== 'page') return;
        try {
            const newPage = await target.page();
            if (newPage) {
                newPage.on('pageerror', (error) => logger.error(`Page error: ${error.message}`));
                await attachMonitor(newPage);
            }
        } catch (error) {
            logger.debug(`targetcreated handling: ${error.message}`);
        }
    });

    // Watcher loop: covers same-tab navigation, retries, and prune of closed pages.
    const watcher = setInterval(async () => {
        try {
            for (const [p, m] of [...monitors.entries()]) {
                if (p.isClosed()) {
                    m.stopMonitoring();
                    monitors.delete(p);
                    logger.info('Game page closed — monitor removed');
                }
            }
            const pages = await browser.pages();
            for (const p of pages) {
                if (!monitors.has(p)) await attachMonitor(p);
            }
        } catch (error) {
            logger.debug(`Watcher loop: ${error.message}`);
        }
    }, 3000);

    await navigateToGame(page);
    await attachMonitor(page); // in case the game loaded in the same tab

    // ---- Graceful shutdown ----
    let shuttingDown = false;
    const shutdown = async (reason) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`Shutting down (${reason})...`);
        clearInterval(watcher);
        for (const monitor of monitors.values()) monitor.stopMonitoring();
        if (predictor) predictor.save();
        try { await browser.close(); } catch (error) { /* already closed */ }
        database.disconnect();
        if (dashboard) { try { dashboard.server.close(); } catch (error) { /* ignore */ } }
        rl.close();
        logger.info('Cleanup completed — history and model state saved');
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
