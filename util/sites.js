const fs = require('fs');
const path = require('path');

/**
 * Site registry — the bot is NOT BetPawa-only.
 *
 * Each site profile knows its URLs, currency, login flow and which game
 * widget selector set it uses. Aviator is the SAME Spribe game everywhere
 * (one global round feed), so the in-game selectors are shared; only the
 * site chrome (URLs, login) differs.
 *
 * Every profile carries a REAL config structure:
 *   baseUrl         — landing/home page
 *   loginUrl        — where the login form lives (page/modal anchor)
 *   loginSelectors  — best-effort hints for the login form fields
 *   balanceSelector — where the wallet balance is shown
 *   gameUrl         — deep link to Aviator ('' = open it from the menu)
 *
 * Login stays MANUAL by design: the bot never types credentials. The
 * selector hints exist so the dashboard/tooling can point at the right
 * fields and detect a logged-in state.
 *
 * Adding a site = adding an entry here (or using the CUSTOM profile with
 * env vars). If a site serves a non-Spribe build, add a new selector set.
 */

const SELECTOR_SETS = {
    // Standard Spribe Aviator widget (used by virtually all bookmakers).
    // Comma-separated fallbacks: the history-strip bubbles are the round
    // source — some casino embeds wrap them in differently-classed
    // containers, so we accept any variant that still targets the strip.
    spribe: {
        BUBBLE_MULTIPLIER: '.payouts-wrapper .bubble-multiplier, ' +
            '.bets_history .bubble-multiplier, ' +
            '[class*="payouts"] .bubble-multiplier, ' +
            '[class*="history"] .bubble-multiplier, ' +
            '.bubble-multiplier',
        BALANCE: '.balance .amount',
        BET_BUTTON: 'div.buttons-block > button.btn.btn-success.bet.ng-star-inserted, ' +
            'div.buttons-block > button.btn.bet, button.btn.bet',
        CASHOUT_BUTTON: 'button.cashout.ng-star-inserted, button.cashout, button.btn.cashout',
        BET_INPUT: 'input[inputmode="decimal"]',
        CASHOUT_MULTIPLIER: '.amount span:first-child'
    }
};

// BetPawa-family login modal (phone number + PIN). Shared hints — the exact
// DOM may vary slightly per region; these are comma-separated CSS fallbacks.
const BETPAWA_LOGIN = {
    openLoginButton: 'button.login, a.login, [class*="login"]',
    usernameInput: 'input[name="username"], input[type="tel"]',
    passwordInput: 'input[name="password"], input[type="password"]',
    submitButton: 'button[type="submit"]',
    // Broad on purpose: bookmaker class names vary by region/build. If none
    // of these match, isLoggedIn() falls back to a page-text check for
    // "log out"/"sign out" markers.
    loggedInIndicator: '.balance, [class*="balance"], [class*="user-menu"], [class*="user-info"], ' +
        '[class*="userinfo"], [class*="avatar"], [class*="account-menu"], [class*="logout"], ' +
        'a[href*="logout"], button[class*="logout"]'
};

const SITES = {
    'betpawa.ug': {
        id: 'betpawa.ug',
        name: 'BetPawa Uganda',
        currency: 'UGX',
        baseUrl: 'https://www.betpawa.ug',
        loginUrl: 'https://www.betpawa.ug',
        // Verified casino deep link for Aviator on BetPawa UG
        gameUrl: 'https://www.betpawa.ug/casino/game/3187?redirectBack=%2Fcasino',
        loginFlow: 'manual', // bot waits for you to log in (once per profile)
        loginSelectors: BETPAWA_LOGIN,
        balanceSelector: '.balance .amount',
        minStake: 100,
        selectorSet: 'spribe',
        notes: 'Phone number + PIN login. Aviator is under Instant Games (or search "Aviator").'
    },
    'betpawa.co.zm': {
        id: 'betpawa.co.zm',
        name: 'BetPawa Zambia',
        currency: 'ZMW',
        baseUrl: 'https://www.betpawa.co.zm',
        loginUrl: 'https://www.betpawa.co.zm',
        gameUrl: 'https://www.betpawa.co.zm/aviator-crash-game',
        loginFlow: 'manual',
        loginSelectors: BETPAWA_LOGIN,
        balanceSelector: '.balance .amount',
        minStake: 0.01,
        selectorSet: 'spribe',
        notes: 'Phone number + PIN login. Direct deep link to the Aviator page.'
    },
    'betpawa.co.mw': {
        id: 'betpawa.co.mw',
        name: 'BetPawa Malawi',
        currency: 'MWK',
        baseUrl: 'https://www.betpawa.co.mw',
        loginUrl: 'https://www.betpawa.co.mw',
        // No verified deep link — leave empty: log in, open Aviator from the
        // Instant Games menu yourself, and the watcher finds the game page.
        gameUrl: '',
        loginFlow: 'manual',
        loginSelectors: BETPAWA_LOGIN,
        balanceSelector: '.balance .amount',
        minStake: 100,
        selectorSet: 'spribe',
        notes: 'No verified deep link — open Aviator from the Instant Games menu after login.'
    },
    'fortebet.ug': {
        id: 'fortebet.ug',
        name: 'Fortebet Uganda',
        currency: 'UGX',
        baseUrl: 'https://www.fortebet.ug',
        loginUrl: 'https://www.fortebet.ug',
        // User-verified Aviator deep link (www site, 2026-09-23)
        gameUrl: 'https://www.fortebet.ug/aviator/game/real',
        loginFlow: 'manual', // bot waits for you to log in (once per profile)
        loginSelectors: BETPAWA_LOGIN, // generic hints; login is manual anyway
        balanceSelector: '[class*="balance"], [id*="balance"], [class*="wallet"]', // generic guess; refines once observed
        minStake: 100,
        selectorSet: 'spribe',
        notes: 'Log in once with your phone + PIN — the profile is remembered.'
    },
    custom: {
        id: 'custom',
        name: 'Custom site',
        currency: process.env.CUSTOM_CURRENCY || 'UNITS',
        baseUrl: process.env.CUSTOM_BASE_URL || '',
        loginUrl: process.env.CUSTOM_LOGIN_URL || process.env.CUSTOM_BASE_URL || '',
        gameUrl: process.env.CUSTOM_GAME_URL || '',
        loginFlow: 'manual',
        loginSelectors: {
            openLoginButton: process.env.CUSTOM_LOGIN_OPEN_SELECTOR || '',
            usernameInput: process.env.CUSTOM_LOGIN_USER_SELECTOR || '',
            passwordInput: process.env.CUSTOM_LOGIN_PASS_SELECTOR || '',
            submitButton: process.env.CUSTOM_LOGIN_SUBMIT_SELECTOR || '',
            loggedInIndicator: process.env.CUSTOM_LOGGED_IN_SELECTOR || ''
        },
        balanceSelector: process.env.CUSTOM_BALANCE_SELECTOR || '',
        minStake: parseFloat(process.env.CUSTOM_MIN_STAKE || '0'),
        selectorSet: 'spribe',
        notes: 'Configure via CUSTOM_* env vars (see .env.example).'
    }
};

function getSite(id) {
    return SITES[id] || SITES.custom;
}

function listSites() {
    return Object.values(SITES);
}

function selectorsFor(site) {
    const base = SELECTOR_SETS[site.selectorSet] || SELECTOR_SETS.spribe;
    // Per-site override (fortebet + user-defined sites): a site-specific
    // balance selector beats the generic set default when it differs.
    if (site && site.balanceSelector && site.balanceSelector !== base.BALANCE) {
        return { ...base, BALANCE: site.balanceSelector };
    }
    return base;
}

// ---------------------------------------------------------------------------
// User-defined sites (added from the dashboard, persisted in data/)
// ---------------------------------------------------------------------------
const BUILTIN_IDS = Object.keys(SITES);
let userSites = [];

/**
 * Registers a user site (dashboard "Add site"). Built-ins cannot be
 * overridden and ids must be unique. Returns the full registered profile.
 */
function registerSite(site) {
    if (!site || typeof site.id !== 'string' || !site.id) throw new Error('site needs an id');
    if (BUILTIN_IDS.includes(site.id)) throw new Error('cannot override a built-in site');
    if (SITES[site.id]) throw new Error(`site "${site.id}" already exists`);
    const full = {
        id: site.id,
        name: site.name || site.id,
        currency: site.currency || 'UNITS',
        baseUrl: site.baseUrl,
        loginUrl: site.loginUrl || site.baseUrl,
        gameUrl: site.gameUrl || '',
        loginFlow: 'manual',
        loginSelectors: BETPAWA_LOGIN, // generic fallback hints; manual login anyway
        balanceSelector: site.balanceSelector || '',
        minStake: Number.isFinite(site.minStake) ? site.minStake : 0,
        selectorSet: 'spribe',
        notes: site.notes || 'User-defined site',
        userDefined: true
    };
    SITES[full.id] = full;
    userSites.push(full);
    return full;
}

/**
 * Removes a user-defined site. Built-ins are protected. Returns true/false.
 */
function unregisterSite(id) {
    if (!id || BUILTIN_IDS.includes(id) || !SITES[id] || !SITES[id].userDefined) return false;
    delete SITES[id];
    userSites = userSites.filter((s) => s.id !== id);
    return true;
}

function getUserSites() {
    return [...userSites];
}

/**
 * Loads user sites from a JSON file (one array of site objects).
 * Sites that fail to register (duplicates/bad data) are skipped.
 */
function loadUserSites(file) {
    try {
        if (!fs.existsSync(file)) return 0;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(raw)) return 0;
        let loaded = 0;
        for (const site of raw) {
            try { registerSite(site); loaded++; } catch { /* skip bad/duplicate entry */ }
        }
        return loaded;
    } catch {
        return 0;
    }
}

/**
 * Persists the current user sites to a JSON file.
 */
function saveUserSites(file) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(userSites, null, 2));
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    SITES, SELECTOR_SETS, getSite, listSites, selectorsFor,
    registerSite, unregisterSite, getUserSites, loadUserSites, saveUserSites
};
