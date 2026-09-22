/**
 * Site registry — the bot is NOT BetPawa-only.
 *
 * Each site profile knows its URLs, currency, login flow and which game
 * widget selector set it uses. Aviator is the SAME Spribe game everywhere
 * (one global round feed), so the in-game selectors are shared; only the
 * site chrome (URLs, login) differs.
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

const SITES = {
    'betpawa.ug': {
        id: 'betpawa.ug',
        name: 'BetPawa Uganda',
        currency: 'UGX',
        baseUrl: 'https://www.betpawa.ug',
        gameUrl: 'https://www.betpawa.ug/virtual/aviator',
        loginFlow: 'manual', // bot waits for you to log in (once per profile)
        minStake: 100,
        selectorSet: 'spribe'
    },
    'betpawa.co.zm': {
        id: 'betpawa.co.zm',
        name: 'BetPawa Zambia',
        currency: 'ZMW',
        baseUrl: 'https://www.betpawa.co.zm',
        gameUrl: 'https://www.betpawa.co.zm/aviator-crash-game',
        loginFlow: 'manual',
        minStake: 0.01,
        selectorSet: 'spribe'
    },
    'betpawa.co.mw': {
        id: 'betpawa.co.mw',
        name: 'BetPawa Malawi',
        currency: 'MWK',
        baseUrl: 'https://www.betpawa.co.mw',
        // No verified deep link — leave empty: log in, open Aviator from the
        // Instant Games menu yourself, and the watcher finds the game page.
        gameUrl: '',
        loginFlow: 'manual',
        minStake: 100,
        selectorSet: 'spribe'
    },
    custom: {
        id: 'custom',
        name: 'Custom site',
        currency: process.env.CUSTOM_CURRENCY || 'UNITS',
        baseUrl: process.env.CUSTOM_BASE_URL || '',
        gameUrl: process.env.CUSTOM_GAME_URL || '',
        loginFlow: 'manual',
        minStake: parseFloat(process.env.CUSTOM_MIN_STAKE || '0'),
        selectorSet: 'spribe'
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
