'use strict';

/**
 * Per-site system mode selection (SMART vs PLAIN).
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
 * Choices persist in data/site-modes.json as a plain { siteId: 'SMART' | 'PLAIN' } map.
 */

const fs = require('fs');
const path = require('path');

function siteModesPath(dataDir) {
    return path.join(dataDir, 'site-modes.json');
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
                if (norm === 'PLAIN' || norm === 'SMART') {
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

/**
 * Resolve the EFFECTIVE system mode for a site:
 *   explicit per-site choice -> that mode ('SMART' | 'PLAIN')
 *   fallback mode            -> fallback ('SMART' | 'PLAIN')
 *   default                  -> 'SMART'
 */
function resolveSiteMode(choices, siteId, fallback = 'SMART') {
    const wanted = choices && siteId ? choices[String(siteId)] : null;
    if (wanted && (wanted === 'SMART' || wanted === 'PLAIN')) return wanted;
    if (typeof fallback === 'string') {
        const fbNorm = fallback.trim().toUpperCase();
        if (fbNorm === 'SMART' || fbNorm === 'PLAIN') return fbNorm;
    }
    return 'SMART';
}

module.exports = { loadSiteModes, saveSiteModes, resolveSiteMode, siteModesPath };
