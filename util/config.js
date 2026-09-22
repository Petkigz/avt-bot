/**
 * Central configuration.
 * Every value can be overridden through environment variables (see .env.example).
 * Default target: BetPawa Uganda (Aviator). Log in once in the opened browser;
 * the session is kept in a persistent Chrome profile (data/browser-profile).
 */
require('dotenv').config();
const path = require('path');

const num = (value, fallback) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const config = {
    DATA_DIR,

    NAVIGATION: {
        // Landing/login page
        BASE_URL: process.env.BASE_URL || 'https://www.betpawa.ug',
        // Direct URL of the Aviator game (used after login)
        GAME_URL: process.env.GAME_URL || 'https://www.betpawa.ug/virtual/aviator',
        TIMEOUT: num(process.env.NAVIGATION_TIMEOUT, 60000),
        RUN_DURATION: num(process.env.RUN_DURATION_MS, 24 * 60 * 60 * 1000) // 24 hours
    },

    // Optional extra clicks after reaching BASE_URL (empty for BetPawa — the bot
    // goes straight to GAME_URL once you're logged in).
    NAVIGATION_STEPS: [],

    LOGIN: {
        // When true, the bot waits at the login page until you press ENTER in
        // the terminal (after logging in manually in the browser window).
        MANUAL: bool(process.env.MANUAL_LOGIN, true)
    },

    BROWSER: {
        HEADLESS: bool(process.env.HEADLESS, false),
        // Persistent Chrome profile so your BetPawa login survives restarts.
        USER_DATA_DIR: process.env.USER_DATA_DIR === '' ? undefined
            : (process.env.USER_DATA_DIR || path.join(DATA_DIR, 'browser-profile'))
    },

    GAME: {
        POLLING_INTERVAL: num(process.env.POLLING_INTERVAL, 4000),
        MULTIPLIER_THRESHOLD: num(process.env.MULTIPLIER_THRESHOLD, 1.50),
        HISTORY_SIZE: num(process.env.HISTORY_SIZE, 5), // rounds used for the moving average
        MAX_CONSECUTIVE_FAILURES: num(process.env.MAX_CONSECUTIVE_FAILURES, 5),
        // A bet that could not be confirmed as "in flight" is conservatively
        // written off after this many milliseconds.
        BET_STALENESS_MS: num(process.env.BET_STALENESS_MS, 120000),
        // Round-cycle jitter guard: a bubble change arriving sooner than this
        // after the previous accepted round end is deferred one cycle.
        MIN_ROUND_GAP_MS: num(process.env.MIN_ROUND_GAP_MS, 2000),
        // Absolute maximum lifetime of an open bet before it is written off.
        MAX_BET_LIFETIME_MS: num(process.env.MAX_BET_LIFETIME_MS, 180000),
        // If the flight visibly ended but the crash bubble never appears,
        // settle the round after this grace period.
        FLIGHT_END_GRACE_MS: num(process.env.FLIGHT_END_GRACE_MS, 10000),
        // Rounds to sit out after a strategy/progression reset.
        RESET_COOLDOWN_ROUNDS: num(process.env.RESET_COOLDOWN_ROUNDS, 1),
        // Never let a bet drop the balance below this reserve.
        MIN_BALANCE_RESERVE: num(process.env.MIN_BALANCE_RESERVE, 0)
    },

    // Adaptive model (history learning). See game/predictor.js.
    MODEL: {
        ENABLED: bool(process.env.MODEL_ENABLED, true),
        MIN_SAMPLE_SIZE: num(process.env.MODEL_MIN_SAMPLE_SIZE, 30),
        MIN_ENTRY_PROBABILITY: num(process.env.MODEL_MIN_ENTRY_PROBABILITY, 0.55),
        MAX_ENTRY_PROBABILITY: num(process.env.MODEL_MAX_ENTRY_PROBABILITY, 0.85),
        COLD_STREAK_LIMIT: num(process.env.MODEL_COLD_STREAK_LIMIT, 3),
        COLD_RECOVERY_COUNT: num(process.env.MODEL_COLD_RECOVERY_COUNT, 1)
    },

    // NOTE: BetPawa renders the Spribe Aviator widget, so the selectors below
    // are Spribe's. If BetPawa serves a different build, adjust these.
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

    // Amounts are in the SITE CURRENCY — on BetPawa Uganda that is UGX.
    // Scale accordingly (e.g. initialBet 1000 = UGX 1,000).
    BETTING_STRATEGIES: {
        CONSERVATIVE: {
            name: 'CONSERVATIVE',
            initialBet: 500,
            maxBet: 25000,
            minBet: 500,
            targetMultiplier: 1.20,
            stopLoss: 10000,
            takeProfit: 20000,
            martingaleMultiplier: 1.5,
            averageMultiplierThreshold: 1.50,
            maxConsecutiveLosses: 5
        },
        MODERATE: {
            name: 'MODERATE',
            initialBet: 1000,
            maxBet: 50000,
            minBet: 500,
            targetMultiplier: 1.50,
            stopLoss: 25000,
            takeProfit: 50000,
            martingaleMultiplier: 2,
            averageMultiplierThreshold: 2.00,
            maxConsecutiveLosses: 5
        },
        AGGRESSIVE: {
            name: 'AGGRESSIVE',
            initialBet: 2500,
            maxBet: 100000,
            minBet: 500,
            targetMultiplier: 2.00,
            stopLoss: 50000,
            takeProfit: 150000,
            martingaleMultiplier: 2.5,
            averageMultiplierThreshold: 3.00,
            maxConsecutiveLosses: 5
        }
    }
};

module.exports = config;
