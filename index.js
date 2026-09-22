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
const { startDashboard } = require('./server');

// ---------------------------------------------------------------------------
// Interactive strategy selection (MICRO is the safe default)
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function selectStrategy() {
    if (!process.stdin.isTTY) {
        logger.warn('No interactive terminal detected — defaulting to MICRO strategy');
        return { ...config.BETTING_STRATEGIES.MICRO };
    }

    console.log('\nAvailable Strategies (amounts are in SITE CURRENCY — UGX on BetPawa.ug):');
    console.log('1. MICRO — tiny stakes, recommended default (UGX 100 initial)');
    console.log('2. Conservative (Lower risk, smaller profits)');
    console.log('3. Moderate (Balanced risk and reward)');
    console.log('4. Aggressive (Higher risk, larger potential profits)');
    console.log('5. Custom (Define your own parameters)\n');

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
    console.log(`\nCustom strategy setup (attempt ${attempt}/3) — amounts in UGX on BetPawa.ug`);
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
// Browser automation
// ---------------------------------------------------------------------------
async function initializeBrowser() {
    const launchOptions = {
        headless: config.BROWSER.HEADLESS,
        defaultViewport: null,
        args: ['--start-maximized']
    };
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
        `target ${strategyConfig.targetMultiplier}x | stop-loss ${strategyConfig.stopLoss} | ` +
        `take-profit ${strategyConfig.takeProfit}`
    );

    // ---- Memory: history, model, patterns, bankroll ----
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
        `Memory loaded: ${roundsLoaded} rounds | ` +
        `P(crash >= ${strategyConfig.targetMultiplier}x) = ` +
        `${(predictor ? predictor.probCrashAtLeast(strategyConfig.targetMultiplier) : null ?? 0).toFixed(2)} | ` +
        `patterns known: ${patterns ? patterns.patterns.size : 0} | tier: ${brain.tier} ` +
        `(bets start only after ${config.RISK.MIN_ROUNDS_OBSERVE} rounds of warm-up)`
    );

    // Round-by-round + trade CSV logs
    const csvRounds = new CsvLog(path.join(config.DATA_DIR, 'rounds.csv'), [
        'ts', 'mode', 'roundId', 'crash', 'betPlaced', 'stake', 'outcome', 'pnl',
        'confidence', 'pattern', 'tier', 'regime'
    ]);
    const csvTrades = new CsvLog(path.join(config.DATA_DIR, 'trades.csv'), [
        'ts', 'mode', 'roundId', 'stake', 'target', 'multiplier', 'pnl', 'won', 'tier'
    ]);

    // Optional persistence (DATABASE_ENABLED=true in .env)
    const database = new Database(config);
    database.connect();

    // Live dashboard
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

        const monitor = new GameMonitor(candidate, config, brain, { historyStore, csvRounds });
        monitors.set(candidate, monitor);

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
        monitor.on('status', (s) => {
            if (dashboard) dashboard.io.emit('status', s);
        });
        monitor.on('tradingStopped', () => {
            logger.warn('Trading halted — monitoring continues');
            if (dashboard) dashboard.io.emit('tradingStopped', true);
        });
        monitor.on('needsRenavigation', async () => {
            logger.info('Re-navigating game page to the Aviator URL...');
            await gotoSafe(candidate, config.NAVIGATION.GAME_URL);
        });

        monitor.startMonitoring();
        logger.info(`Game monitor started on ${candidate.url()}`);
    };

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
    await attachMonitor(page);

    // ---- Graceful shutdown ----
    let shuttingDown = false;
    const shutdown = async (reason) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`Shutting down (${reason})...`);
        clearInterval(watcher);
        for (const monitor of monitors.values()) monitor.stopMonitoring();
        if (predictor) predictor.save();
        if (patterns) patterns.save();
        if (bankroll) bankroll.save();
        try { await browser.close(); } catch (error) { /* already closed */ }
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
