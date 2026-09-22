require('dotenv').config();

const puppeteer = require('puppeteer');
const readline = require('readline');
const config = require('./util/config');
const logger = require('./util/logger');
const sleep = require('./util/sleep');
const FrameHelper = require('./util/frameHelper');
const GameMonitor = require('./game/gameMonitor');
const BettingStrategy = require('./game/strategies');
const Database = require('./database/database');
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

    console.log('\nAvailable Strategies:');
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
    console.log(`\nCustom strategy setup (attempt ${attempt}/3)`);
    const askNum = async (label) => parseFloat(await askQuestion(label));

    const strategy = {
        name: 'CUSTOM',
        initialBet: await askNum('Initial bet amount: '),
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
    const browser = await puppeteer.launch({
        headless: config.BROWSER.HEADLESS,
        defaultViewport: null,
        args: ['--start-maximized']
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.NAVIGATION.TIMEOUT);
    return { browser, page };
}

async function navigateInitialPages(page) {
    try {
        await page.goto(config.NAVIGATION.BASE_URL, {
            waitUntil: 'networkidle2',
            timeout: config.NAVIGATION.TIMEOUT
        });
    } catch (error) {
        logger.warn(`networkidle2 wait timed out, continuing anyway: ${error.message}`);
    }

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
    logger.info('Starting Aviator Bot...');

    const strategyConfig = await selectStrategy();
    logger.info(
        `Strategy: ${strategyConfig.name} | initial bet ${strategyConfig.initialBet} | ` +
        `target ${strategyConfig.targetMultiplier}x | stop-loss ${strategyConfig.stopLoss} | ` +
        `take-profit ${strategyConfig.takeProfit}`
    );

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
    logger.info('Browser initialized');

    // If the browser process dies, nothing can recover in-process — exit with
    // a non-zero code so a supervisor (pm2, systemd, docker restart policy...)
    // can bring the whole bot back up cleanly.
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

        // Surface page-level failures loudly instead of silently stalling.
        try {
            candidate.on('error', (error) => logger.error(`Game page crashed: ${error.message}`));
            candidate.on('pageerror', (error) => logger.error(`Game page JS error: ${error.message}`));
        } catch (error) { /* page may already be closing */ }

        // Fresh strategy instance per monitor so the SELECTED config is used.
        const monitor = new GameMonitor(candidate, config, { ...strategyConfig });
        monitors.set(candidate, monitor);

        monitor.on('roundEnded', (d) => {
            database.saveRound(d.crash);
            if (dashboard) {
                dashboard.io.emit('newData', {
                    value: d.crash,
                    created_at: Date.now(),
                    predictedValue: d.nextPrediction
                });
            }
        });
        monitor.on('trade', (t) => {
            database.saveTrade(t);
            if (dashboard) dashboard.io.emit('trade', t);
        });
        monitor.on('tradingStopped', () => {
            logger.warn('Risk limits reached — betting halted, monitoring continues');
            if (dashboard) dashboard.io.emit('tradingStopped', true);
        });

        monitor.startMonitoring();
        logger.info(`Game monitor started on ${candidate.url()}`);
    };

    // New tabs/pages: check them, but WITHOUT the old waitForNavigation race —
    // attachMonitor simply no-ops until the game markup actually exists.
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

    // Watcher loop: also covers SAME-TAB navigation (no targetcreated event)
    // and retries pages that were not ready yet.
    const watcher = setInterval(async () => {
        try {
            // Prune monitors whose page has been closed.
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

    await navigateInitialPages(page);
    await attachMonitor(page); // in case the game loaded in the same tab

    // ---- Graceful shutdown ----
    let shuttingDown = false;
    const shutdown = async (reason) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`Shutting down (${reason})...`);
        clearInterval(watcher);
        for (const monitor of monitors.values()) monitor.stopMonitoring();
        try { await browser.close(); } catch (error) { /* already closed */ }
        database.disconnect();
        if (dashboard) { try { dashboard.server.close(); } catch (error) { /* ignore */ } }
        rl.close();
        logger.info('Cleanup completed');
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
