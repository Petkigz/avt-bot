/**
 * Central configuration.
 * Every value can be overridden through environment variables (see .env.example).
 */
require('dotenv').config();

const num = (value, fallback) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const config = {
    NAVIGATION: {
        BASE_URL: process.env.BASE_URL || 'https://spribe.co/welcome',
        TIMEOUT: num(process.env.NAVIGATION_TIMEOUT, 60000),
        RUN_DURATION: num(process.env.RUN_DURATION_MS, 24 * 60 * 60 * 1000) // 24 hours
    },

    // Ordered list of clicks to reach the game from the landing page.
    // `required: false` steps are skipped when the element is absent.
    NAVIGATION_STEPS: [
        { name: 'accordion', selector: '.accordion-body.shadow', required: true },
        { name: 'demo button', selector: '.btn.btn-primary.btn-lg.px-5.btn-demo.btn-danger', required: true },
        { name: 'age confirmation', selector: '.btn.btn-md.btn-primary.btn-age', required: false }
    ],

    BROWSER: {
        HEADLESS: bool(process.env.HEADLESS, false)
    },

    GAME: {
        POLLING_INTERVAL: num(process.env.POLLING_INTERVAL, 4000),
        MULTIPLIER_THRESHOLD: num(process.env.MULTIPLIER_THRESHOLD, 1.50),
        HISTORY_SIZE: num(process.env.HISTORY_SIZE, 3), // number of previous rounds kept for the average
        MAX_CONSECUTIVE_FAILURES: num(process.env.MAX_CONSECUTIVE_FAILURES, 5),
        // A bet that could not be confirmed as "in flight" is conservatively
        // written off after this many milliseconds.
        BET_STALENESS_MS: num(process.env.BET_STALENESS_MS, 120000)
    },

    SELECTORS: {
        GAME: {
            BUBBLE_MULTIPLIER: '.payouts-wrapper .bubble-multiplier',
            BALANCE: '.balance .amount',
            BET_BUTTON: 'div.buttons-block > button.btn.btn-success.bet.ng-star-inserted',
            CASHOUT_BUTTON: 'button.cashout.ng-star-inserted',
            BET_INPUT: 'input[inputmode="decimal"]',
            CASHOUT_MULTIPLIER: '.amount span:first-child'
        }
    },

    DATABASE: {
        ENABLED: bool(process.env.DATABASE_ENABLED, false),
        host: process.env.DB_HOST || 'localhost',
        port: num(process.env.DB_PORT, 3306),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'aviatorBot'
    },

    DASHBOARD: {
        ENABLED: bool(process.env.DASHBOARD_ENABLED, true),
        PORT: num(process.env.DASHBOARD_PORT, 3000)
    },

    LOG_LEVEL: process.env.LOG_LEVEL || 'info',

    BETTING_STRATEGIES: {
        CONSERVATIVE: {
            name: 'CONSERVATIVE',
            initialBet: 1.00,
            maxBet: 50.00,
            minBet: 1.00,
            targetMultiplier: 1.20,
            stopLoss: 20.00,
            takeProfit: 40.00,
            martingaleMultiplier: 1.5,
            averageMultiplierThreshold: 1.50
        },
        MODERATE: {
            name: 'MODERATE',
            initialBet: 2.00,
            maxBet: 100.00,
            minBet: 1.00,
            targetMultiplier: 1.50,
            stopLoss: 50.00,
            takeProfit: 100.00,
            martingaleMultiplier: 2,
            averageMultiplierThreshold: 2.00
        },
        AGGRESSIVE: {
            name: 'AGGRESSIVE',
            initialBet: 5.00,
            maxBet: 200.00,
            minBet: 1.00,
            targetMultiplier: 2.00,
            stopLoss: 100.00,
            takeProfit: 300.00,
            martingaleMultiplier: 2.5,
            averageMultiplierThreshold: 3.00
        }
    }
};

module.exports = config;
