/**
 * npm run demo — OFFLINE demo feed.
 *
 * Streams synthetic Aviator rounds through the REAL dashboard, CSV logs and
 * history store (kept isolated under data/demo/ so real memory is untouched).
 * Use it to verify the dashboard, charts, sessions panel and log pipeline
 * WITHOUT logging into any bookmaker. No bets, no browser, no risk.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const logger = require('../util/logger');
const CsvLog = require('../util/csvLog');
const AccountsManager = require('../util/accounts');
const { startDashboard } = require('../server');

const DEMO_DIR = path.join(config.DATA_DIR, 'demo');
fs.mkdirSync(DEMO_DIR, { recursive: true });

const ROUND_HEADER = ['ts', 'mode', 'site', 'account', 'roundId', 'crash', 'betPlaced',
    'stake', 'outcome', 'pnl', 'confidence', 'pattern', 'tier', 'regime'];
const TRADE_HEADER = ['ts', 'mode', 'site', 'account', 'roundId', 'stake', 'target',
    'multiplier', 'pnl', 'won', 'tier'];

const csvRounds = new CsvLog(path.join(DEMO_DIR, 'rounds.csv'), ROUND_HEADER);
const csvTrades = new CsvLog(path.join(DEMO_DIR, 'trades.csv'), TRADE_HEADER);

// ---- Synthetic state ---------------------------------------------------------
let roundId = 0;
let balance = 10000;
let sessionPnl = 0;
let totalTrades = 0;
let wins = 0;
const decisionFeed = [];
const historyFile = path.join(DEMO_DIR, 'history.json');
let history = [];
try {
    const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (Array.isArray(raw)) history = raw;
} catch { /* fresh demo memory */ }

// Aviator-like crash distribution with ~1% house edge
function genCrash() {
    if (Math.random() < 0.03) return 1.0;
    const v = Math.min(0.99 / (1 - Math.random()), 250);
    return Math.max(1.0, Math.floor(v * 100) / 100);
}

function tierFor(rounds) {
    if (rounds < 40) return 'OBSERVING';
    if (rounds < 80) return 'MICRO';
    return 'ARMED';
}

function pushDecision(entry) {
    decisionFeed.push(entry);
    if (decisionFeed.length > 12) decisionFeed.shift();
}

let modelProb = 0.62;
let regime = 'neutral';

function buildStatus(tier, lastCrash) {
    modelProb = Math.min(0.8, Math.max(0.42, modelProb + (Math.random() - 0.5) * 0.05));
    regime = lastCrash < 1.3 ? 'cold' : lastCrash > 2.5 ? 'hot' : 'neutral';
    const sessionLimitUsed = Math.min(1, Math.max(0, -sessionPnl) / config.RISK.SESSION_LOSS_LIMIT);
    const dailyLimitUsed = Math.min(1, Math.max(0, -sessionPnl) / config.RISK.DAILY_LOSS_LIMIT);
    return {
        tradingHalted: false,
        cooldownRounds: 0,
        inFlight: false,
        balance,
        roundId,
        stats: {
            netProfit: sessionPnl,
            totalTrades,
            winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0
        },
        strategy: {
            name: 'MICRO (demo)',
            nextStake: 100,
            minBet: 100,
            maxBet: 800,
            targetMultiplier: 1.3,
            martingaleMultiplier: 1.4,
            stopLoss: 1500,
            takeProfit: 2000
        },
        brain: {
            mode: 'paper',
            tier,
            microOnly: false,
            hitRate: totalTrades > 0 ? wins / totalTrades : null,
            lastReasons: decisionFeed.length ? [decisionFeed[decisionFeed.length - 1].reason] : [],
            decisionFeed: [...decisionFeed],
            model: {
                regime,
                probability: modelProb,
                entryProbability: config.MODEL.MIN_ENTRY_PROBABILITY,
                roundsStudied: roundId,
                bestTarget: { target: 1.3, ev: 0.021 }
            },
            patterns: {
                current: roundId > 5 ? { pattern: 'L,H,L', probability: modelProb + 0.03, risky: false } : null,
                topPatterns: [
                    { pattern: 'L,H,L,H,L,H,L,H,L,H', length: 10, seen: 14, used: 3, probability: 0.71, benched: false },
                    { pattern: 'H,L,M,H,L', length: 5, seen: 22, used: 5, probability: 0.66, benched: false },
                    { pattern: 'M,L,H', length: 3, seen: 41, used: 9, probability: 0.63, benched: false }
                ]
            },
            bankroll: {
                sessionPnl,
                dailyPnl: sessionPnl,
                sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
                dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
                sessionLimitUsed,
                dailyLimitUsed
            }
        }
    };
}

async function main() {
    const accounts = new AccountsManager(DEMO_DIR);
    accounts.ensureDefault('demo.ug');

    logger.warn('=====================================================================');
    logger.warn('DEMO MODE — synthetic rounds, isolated data/demo/ store. NO real site.');
    logger.warn('=====================================================================');

    const dashboard = await startDashboard(config.DASHBOARD.PORT, logger, {
        accounts,
        dataDir: DEMO_DIR,
        getActiveSite: () => ({ id: 'demo.ug', name: 'Demo feed (synthetic)', currency: 'UGX' }),
        getSessions: () => [{
            accountId: 'demo',
            accountLabel: 'demo account',
            siteId: 'demo.ug',
            siteName: 'Demo feed (synthetic)',
            currency: 'UGX',
            phase: 'monitoring',
            monitoring: true,
            roundsSeen: roundId,
            roundsPerHour: 3000,
            stalled: false,
            balance: Math.round(balance)
        }]
    });

    const timer = setInterval(() => {
        roundId++;
        const crash = genCrash();
        const tier = tierFor(roundId);
        history.push(crash);
        if (history.length > 20000) history.shift();

        // Occasionally place a hypothetical bet once out of warm-up
        let betPlaced = false;
        let outcome = 'none';
        let pnl = 0;
        let stake = '';
        if (tier !== 'OBSERVING' && Math.random() < 0.3) {
            betPlaced = true;
            stake = 100;
            const won = crash >= 1.3;
            pnl = won ? stake * 0.3 : -stake;
            outcome = won ? 'win' : 'loss';
            totalTrades++;
            if (won) wins++;
            sessionPnl += pnl;
            balance += pnl;
            csvTrades.write({
                ts: new Date().toISOString(), mode: 'paper', site: 'demo.ug',
                account: 'demo account', roundId, stake, target: 1.3,
                multiplier: won ? 1.3 : crash, pnl, won: won ? 'yes' : 'no', tier
            });
            dashboard.io.emit('trade', {
                betAmount: stake, won, multiplier: won ? 1.3 : crash,
                profit: won ? pnl : 0, loss: won ? 0 : -pnl
            });
            pushDecision({ ts: Date.now(), bet: true, stake, tier, reason: won ? `demo bet won at 1.30x (crash ${crash}x)` : `demo bet lost — crashed ${crash}x` });
        } else {
            pushDecision({ ts: Date.now(), bet: false, stake: '', tier, reason: tier === 'OBSERVING' ? 'warm-up: observing only' : 'demo: model below entry threshold' });
        }

        csvRounds.write({
            ts: new Date().toISOString(), mode: 'paper', site: 'demo.ug',
            account: 'demo account', roundId, crash,
            betPlaced: betPlaced ? 'yes' : 'no', stake, outcome, pnl,
            confidence: betPlaced ? 0.64 : '', pattern: betPlaced ? 'L,H,L' : '',
            tier, regime
        });

        dashboard.io.emit('newData', {
            value: crash,
            created_at: Date.now(),
            predictedValue: modelProb > 0.6 ? 1.8 : 1.2
        });
        dashboard.io.emit('status', buildStatus(tier, crash));
    }, 1200);

    const saveHistory = () => {
        try { fs.writeFileSync(historyFile, JSON.stringify(history)); } catch { /* ignore */ }
    };
    const historySaver = setInterval(saveHistory, 15000);

    const shutdown = () => {
        logger.info('Demo stopped — saving history');
        clearInterval(timer);
        clearInterval(historySaver);
        saveHistory();
        dashboard.server.close();
        dashboard.io.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    logger.info(`Demo dashboard: http://localhost:${config.DASHBOARD.PORT} — Ctrl+C to stop`);
}

main().catch((error) => {
    logger.error(`Demo failed to start: ${error.stack || error.message}`);
    process.exit(1);
});
