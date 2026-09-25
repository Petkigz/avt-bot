'use strict';

/**
 * Per-site system mode selection (SMART vs PLAIN vs IRRATIONAL) and Daily Quotas.
 *
 * SMART: Full AI & statistical ensemble gating (ML feature models, pattern miner,
 *        calibrated probabilities, tier warm-up, volatility risk adjustments,
 *        loss-streak pauses).
 *
 * PLAIN: Pure mechanical strategy execution. Bets on every round according to
 *        the selected strategy's target and progression (flat or Martingale)
 *        without ML filters or warm-up delays, while keeping hard bankroll
 *        safety limits enforced.
 *
 * IRRATIONAL: Unhinged bold goal-seeking play. Focuses 100% on fulfilling a daily
 *        profit quota by dynamically escalating stakes and multipliers based on
 *        house liquidity momentum and quota distance.
 *
 * Choices persist in data/site-modes.json and data/site-quotas.json.
 */

const fs = require('fs');
const path = require('path');

const VALID_MODES = new Set(['SMART', 'PLAIN', 'IRRATIONAL']);

function siteModesPath(dataDir) {
    return path.join(dataDir, 'site-modes.json');
}

function siteQuotasPath(dataDir) {
    return path.join(dataDir, 'site-quotas.json');
}

/** Load the per-site system mode map. Missing/corrupt file -> empty map. */
function loadSiteModes(dataDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(siteModesPath(dataDir), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [siteId, mode] of Object.entries(raw)) {
            if (typeof siteId === 'string' && siteId.trim() &&
                typeof mode === 'string' && mode.trim()) {
                const norm = mode.trim().toUpperCase();
                if (VALID_MODES.has(norm)) {
                    out[siteId.trim()] = norm;
                }
            }
        }
        return out;
    } catch (error) {
        return {}; // first run, or a torn write — defaults stay in force
    }
}

/** Persist the map. Never throws. */
function saveSiteModes(dataDir, choices) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(siteModesPath(dataDir), JSON.stringify(choices || {}, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

/** Load the per-site daily profit quotas. */
function loadSiteQuotas(dataDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(siteQuotasPath(dataDir), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [siteId, quota] of Object.entries(raw)) {
            const n = parseFloat(quota);
            if (typeof siteId === 'string' && siteId.trim() && Number.isFinite(n) && n > 0) {
                out[siteId.trim()] = n;
            }
        }
        return out;
    } catch (error) {
        return {};
    }
}

/** Persist per-site daily profit quotas. */
function saveSiteQuotas(dataDir, quotas) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(siteQuotasPath(dataDir), JSON.stringify(quotas || {}, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Resolve the EFFECTIVE system mode for a site:
 *   explicit per-site choice -> that mode ('SMART' | 'PLAIN' | 'IRRATIONAL')
 *   fallback mode            -> fallback ('SMART' | 'PLAIN' | 'IRRATIONAL')
 *   default                  -> 'SMART'
 */
function resolveSiteMode(choices, siteId, fallback = 'SMART') {
    const wanted = choices && siteId ? choices[String(siteId)] : null;
    if (wanted && VALID_MODES.has(wanted)) return wanted;
    if (typeof fallback === 'string') {
        const fbNorm = fallback.trim().toUpperCase();
        if (VALID_MODES.has(fbNorm)) return fbNorm;
    }
    return 'SMART';
}

/** Resolve the effective daily profit quota for a site. */
function resolveSiteQuota(quotas, siteId, fallback = 10000) {
    const wanted = quotas && siteId ? parseFloat(quotas[String(siteId)]) : NaN;
    if (Number.isFinite(wanted) && wanted > 0) return wanted;
    const fb = parseFloat(fallback);
    return Number.isFinite(fb) && fb > 0 ? fb : 10000;
}

module.exports = {
    loadSiteModes, saveSiteModes, resolveSiteMode, siteModesPath,
    loadSiteQuotas, saveSiteQuotas, resolveSiteQuota, siteQuotasPath,
    VALID_MODES
};
