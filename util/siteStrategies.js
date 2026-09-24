'use strict';

/**
 * Per-site strategy selection.
 *
 * Each bookmaker hosts its OWN Aviator stream, so each site is an
 * independent book — and now each site can run its OWN betting strategy
 * (betpawa on MICRO while fortebet runs AGGRESSIVE). Choices persist in
 * data/site-strategies.json as a plain { siteId: PRESET_NAME } map and
 * survive restarts.
 *
 * Design rules:
 *  - A site with NO explicit choice runs the global default strategy
 *    (whatever was picked at launch / CLI) — never a hardcoded preset.
 *  - An UNKNOWN persisted name (edited file, renamed preset) falls back to
 *    the default silently rather than crashing the engine boot.
 */

const fs = require('fs');
const path = require('path');

function siteStrategiesPath(dataDir) {
    return path.join(dataDir, 'site-strategies.json');
}

/** Load the per-site strategy map. Missing/corrupt file -> empty map. */
function loadSiteStrategies(dataDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(siteStrategiesPath(dataDir), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [siteId, name] of Object.entries(raw)) {
            if (typeof siteId === 'string' && siteId.trim() &&
                typeof name === 'string' && name.trim()) {
                out[siteId.trim()] = name.trim().toUpperCase();
            }
        }
        return out;
    } catch (error) {
        return {}; // first run, or a torn write — defaults stay in force
    }
}

/** Persist the map. Logging is the caller's job; this never throws. */
function saveSiteStrategies(dataDir, choices) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(siteStrategiesPath(dataDir), JSON.stringify(choices || {}, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Resolve the EFFECTIVE strategy preset config for a site:
 *   explicit valid per-site choice  ->  that preset
 *   anything else (no choice, unknown name) -> the supplied fallback
 *   no fallback either             ->  MICRO as the last-resort safe preset
 */
function resolveSiteStrategy(choices, siteId, presetTable, fallback) {
    const wanted = choices && siteId ? choices[String(siteId)] : null;
    if (wanted && presetTable && presetTable[wanted]) return presetTable[wanted];
    if (fallback && typeof fallback === 'object' && Number.isFinite(fallback.initialBet)) {
        return fallback;
    }
    return (presetTable && presetTable.MICRO) || null;
}

module.exports = { loadSiteStrategies, saveSiteStrategies, resolveSiteStrategy, siteStrategiesPath };
