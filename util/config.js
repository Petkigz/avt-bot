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
        RESET_COOLDOWN_ROUNDS: num(process.env.RESET_COOLDOWN_ROUNDS, 2),
        // Never let a bet drop the balance below this reserve.
        MIN_BALANCE_RESERVE: num(process.env.MIN_BALANCE_RESERVE, 0)
    },

    // Adaptive model (history learning). See game/predictor.js.
    MODEL: {
        ENABLED: bool(process.env.MODEL_ENABLED, true),
        MIN_SAMPLE_SIZE: num(process.env.MODEL_MIN_SAMPLE_SIZE, 30),
        MIN_ENTRY_PROBABILITY: num(process.env.MODEL_MIN_ENTRY_PROBABILITY, 0.60),
        MAX_ENTRY_PROBABILITY: num(process.env.MODEL_MAX_ENTRY_PROBABILITY, 0.85),
        COLD_STREAK_LIMIT: num(process.env.MODEL_COLD_STREAK_LIMIT, 3),
        COLD_RECOVERY_COUNT: num(process.env.MODEL_COLD_RECOVERY_COUNT, 1),
        // Recency weighting: how fast old rounds stop counting (in rounds).
        RECENCY_HALF_LIFE: num(process.env.MODEL_RECENCY_HALF_LIFE, 250),
        // Window (rounds) for the recent estimate + Wilson uncertainty bound.
        RECENT_WINDOW: num(process.env.MODEL_RECENT_WINDOW, 100),
        // How far below the entry threshold the Wilson floor may sit.
        WILSON_CUSHION: num(process.env.MODEL_WILSON_CUSHION, 0.05),
        // How the walk-forward verdict participates in live decisions:
        //   advisory — verdict is computed, stored and displayed (default)
        //   strict   — a site may only bet after its OWN out-of-sample
        //              validation has found predictive signal ("I don't know
        //              -> don't bet").
        SIGNAL_POLICY: (process.env.MODEL_SIGNAL_POLICY || 'advisory').toLowerCase()
    },

    // Pattern mining over recent round clusters. See game/patternDetector.js.
    PATTERN: {
        ENABLED: bool(process.env.PATTERN_ENABLED, true),
        LENGTHS: (process.env.PATTERN_LENGTHS || '10,5,3')
            .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 2),
        MIN_SUPPORT: num(process.env.PATTERN_MIN_SUPPORT, 8),
        BINS: (process.env.PATTERN_BINS || '1.5,2.5')
            .split(',').map((s) => parseFloat(s.trim())).filter(Number.isFinite),
        // Confidence multiplier when NO known pattern matches (unconfirmed round).
        NO_PATTERN_PENALTY: num(process.env.PATTERN_NO_PATTERN_PENALTY, 0.95),
        // A mined pattern only gains influence in proportion to its LIVE track
        // record; it needs this many settled real uses for full weight
        // (protection against in-sample noise patterns).
        MIN_LIVE_USES: num(process.env.PATTERN_MIN_LIVE_USES, 10)
    },

    // Bankroll & confidence-tier policy. See game/bankroll.js and game/brain.js.
    RISK: {
        // Hard loss limits (site currency — UGX on BetPawa.ug)
        SESSION_LOSS_LIMIT: num(process.env.SESSION_LOSS_LIMIT, 3000),
        DAILY_LOSS_LIMIT: num(process.env.DAILY_LOSS_LIMIT, 6000),
        // A stake can never exceed this fraction of the bankroll
        MAX_STAKE_FRACTION: num(process.env.MAX_STAKE_FRACTION, 0.015),
        // While unproven (MICRO tier), stakes are capped at this fraction
        MICRO_STAKE_FRACTION: num(process.env.MICRO_STAKE_FRACTION, 0.004),
        // Warm-up: rounds to study before ANY bet is allowed
        MIN_ROUNDS_OBSERVE: num(process.env.MIN_ROUNDS_OBSERVE, 150),
        // Scale stakes with model confidence (50%-100% of the approved stake)
        CONFIDENCE_SCALING: bool(process.env.CONFIDENCE_SCALING, true),
        // Promotion MICRO -> ARMED
        PROMOTION_MIN_DECISIONS: num(process.env.PROMOTION_MIN_DECISIONS, 25),
        PROMOTION_HIT_RATE: num(process.env.PROMOTION_HIT_RATE, 0.58),
        // Demotion ARMED -> MICRO
        DEMOTION_HIT_RATE: num(process.env.DEMOTION_HIT_RATE, 0.48),
        DECISION_WINDOW: num(process.env.DECISION_WINDOW, 30),
        // Volatility risk evaluation
        HIGH_VOLATILITY_THRESHOLD: num(process.env.HIGH_VOLATILITY_THRESHOLD, 2.0),
        VOLATILITY_CONFIDENCE_PENALTY: num(process.env.VOLATILITY_CONFIDENCE_PENALTY, 0.07)
    },

    MODE: {
        // SAFE DEFAULT: paper mode observes the real site and logs hypothetical
        // trades but never clicks. Set PAPER_MODE=false to bet real funds.
        PAPER: bool(process.env.PAPER_MODE, true),
        // Hypothetical bankroll for the paper simulation (Profits panel).
        // 0 = derive from the selected strategy: 100 x its initial bet.
        PAPER_BANKROLL: num(process.env.PAPER_BANKROLL, 0)
    },

    // Multi-site / multi-account
    SESSIONS: {
        // Max concurrent browser sessions (one per account). Raise to run
        // several accounts at once; each costs RAM.
        MAX: num(process.env.MAX_SESSIONS, 1)
    },

    // Which site to start on. Registered sites live in util/sites.js
    // (betpawa.ug, betpawa.co.zm, betpawa.co.mw, custom). Switch anytime
    // from the dashboard.
    SITE_ID: process.env.SITE || 'betpawa.ug',

    // Start from the dashboard instead of the terminal prompts (site,
    // account and strategy are chosen in Mission Control, then LAUNCH).
    // Dashboard-first is the default flow: the bot waits for Mission
    // Control's LAUNCH button instead of asking questions in the terminal.
    // Set UI_START=false for the classic terminal menus.
    UI_START: bool(process.env.UI_START, true),

    // Optional preset override — MICRO, CONSERVATIVE, MODERATE or AGGRESSIVE.
    // When set, the bot uses it without prompting (useful for headless runs).
    // Leave empty for the interactive menu (all presets + custom available).
    STRATEGY: (process.env.STRATEGY || '').toUpperCase(),

    // Strict safety profile: stay in the MICRO tier forever (micro-sized bets
    // only, never promoted to full strategy stakes).
    MICRO_ONLY: bool(process.env.MICRO_ONLY, false),

    // NOTE: BetPawa renders the Spribe Aviator widget, so the selectors below
    // are Spribe's. If BetPawa serves a different build, adjust these.
    SELECTORS: {
        // Global defaults (per-site sets in util/sites.js override these via
        // the monitor). Comma-separated fallbacks cover Spribe client
        // variations (e.g. the aviator-next build without .ng-star-inserted).
        GAME: {
            BUBBLE_MULTIPLIER: '.payouts-wrapper .bubble-multiplier',
            BALANCE: '.balance .amount',
            BET_BUTTON: 'div.buttons-block > button.btn.btn-success.bet.ng-star-inserted, ' +
                'div.buttons-block > button.btn.bet, button.btn.bet',
            CASHOUT_BUTTON: 'button.cashout.ng-star-inserted, button.cashout, button.btn.cashout',
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
        // 4100 is less contested than 3000; if it IS busy the server walks
        // up to 10 higher ports automatically (see server.js).
        PORT: num(process.env.DASHBOARD_PORT, 4100),
        // Network interface the dashboard binds to. DEFAULT IS LOCAL-ONLY:
        // the dashboard has no built-in auth, so keep it on your machine.
        // Set 0.0.0.0 only if you understand anyone on your LAN could
        // view and control the bot.
        HOST: process.env.DASHBOARD_HOST || '127.0.0.1'
    },

    LOG_LEVEL: process.env.LOG_LEVEL || 'info',

    // Amounts are in the SITE CURRENCY — on BetPawa Uganda that is UGX.
    // MICRO is the DEFAULT: tiny stakes until the bot proves itself.
    BETTING_STRATEGIES: {
        MICRO: {
            name: 'MICRO',
            initialBet: 100,
            maxBet: 800,
            minBet: 100,
            targetMultiplier: 1.30,
            stopLoss: 1500,
            takeProfit: 2000,
            martingaleMultiplier: 1.3,
            averageMultiplierThreshold: 1.80,
            maxConsecutiveLosses: 4
        },
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
        },
        // Model-driven target: instead of a fixed 1.2x/1.3x/2x, each round's
        // target is DRAWN from the model's live read of the crash
        // distribution (hot tail -> bigger targets, cold tail -> smaller).
        // targetMultiplier is only the nominal anchor for the regime guard
        // and pattern mining; the real target varies every round.
        ADAPTIVE: {
            name: 'ADAPTIVE',
            initialBet: 500,
            maxBet: 25000,
            minBet: 100,
            targetMultiplier: 1.50,
            adaptiveTarget: true,
            adaptiveMin: 1.30,
            adaptiveMax: 30,
            stopLoss: 15000,
            takeProfit: 50000,
            martingaleMultiplier: 1.5,
            averageMultiplierThreshold: 2.00,
            maxConsecutiveLosses: 6
        }
    }
};

module.exports = config;
