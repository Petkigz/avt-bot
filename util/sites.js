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
    // Standard Spribe Aviator widget (used by virtually all bookmakers)
    spribe: {
        BUBBLE_MULTIPLIER: '.payouts-wrapper .bubble-multiplier',
        BALANCE: '.balance .amount',
        BET_BUTTON: 'div.buttons-block > button.btn.btn-success.bet.ng-star-inserted',
        CASHOUT_BUTTON: 'button.cashout.ng-star-inserted',
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
    loggedInIndicator: '.balance, [class*="user-menu"], [class*="avatar"]'
};

const SITES = {
    'betpawa.ug': {
        id: 'betpawa.ug',
        name: 'BetPawa Uganda',
        currency: 'UGX',
        baseUrl: 'https://www.betpawa.ug',
        loginUrl: 'https://www.betpawa.ug',
        gameUrl: 'https://www.betpawa.ug/virtual/aviator',
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
    return SELECTOR_SETS[site.selectorSet] || SELECTOR_SETS.spribe;
}

module.exports = { SITES, SELECTOR_SETS, getSite, listSites, selectorsFor };
