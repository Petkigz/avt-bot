'use strict';

/**
 * game/signalLifecycle.js
 *
 * Signal Lifecycle Manager & Live-Shadow Evaluation Engine.
 *
 * Manages the transition of discovered scientific hypotheses across their lifecycle:
 *   DISCOVERED -> OOS_CONFIRMED -> HOLDOUT_CONFIRMED -> LIVE_SHADOW -> LIVE_MICRO -> DRIFTING -> RETIRED
 *
 * Connects confirmed research candidates to the live Brain, tracks real-time performance
 * in shadow mode, detects edge decay, and retires obsolete signals automatically.
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const logger = require('../util/logger');
const { generateHypotheses } = require('../research/hypothesisEngine');
const { hitRatePValue } = require('./modelLayer');

const MIN_SHADOW_BETS_FOR_PROMOTION = 40;
const MAX_CONSECUTIVE_SIGNAL_LOSSES = 8;
const DRIFT_LIFT_TOLERANCE = -0.05; // -5% below break-even triggers DRIFTING

function wilsonLowerBound(wins, n, z = 1.645) { // 95% one-sided confidence
    if (n <= 0) return 0;
    const p = wins / n;
    const num = p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    const den = 1 + (z * z) / n;
    return Math.max(0, num / den);
}

class SignalLifecycle {
    constructor(siteId = 'default') {
        this.siteId = siteId;
        this.candidates = [];
        this.lastCandRegistryMtime = 0;
        this.hypothesisCatalog = generateHypotheses();
        this.hypMap = new Map();
        for (const h of this.hypothesisCatalog) {
            this.hypMap.set(h.id, h);
        }
        this.load();
    }

    getFilePath() {
        const safeSite = String(this.siteId).replace(/[^a-z0-9._-]/gi, '_');
        return path.join(config.DATA_DIR, `signal-lifecycle-${safeSite}.json`);
    }

    getCandidateRegistryPath() {
        const safeSite = String(this.siteId).replace(/[^a-z0-9._-]/gi, '_');
        return path.join(config.DATA_DIR, `hypothesis-candidates-${safeSite}.json`);
    }

    checkHotReload() {
        const candPath = this.getCandidateRegistryPath();
        if (fs.existsSync(candPath)) {
            try {
                const stat = fs.statSync(candPath);
                if (stat.mtimeMs > this.lastCandRegistryMtime) {
                    this.load();
                }
            } catch (err) {
                // Ignore stat errors
            }
        }
    }

    load() {
        const lifePath = this.getFilePath();
        const candPath = this.getCandidateRegistryPath();

        let loaded = [];
        if (fs.existsSync(lifePath)) {
            try {
                loaded = JSON.parse(fs.readFileSync(lifePath, 'utf8'));
                if (!Array.isArray(loaded)) loaded = [];
            } catch (err) {
                logger.warn(`SignalLifecycle [${this.siteId}]: could not read ${path.basename(lifePath)}: ${err.message}`);
                loaded = [];
            }
        }

        this.candidates = loaded;

        // Auto-synchronize newest confirmed candidates from hypothesis registry
        if (fs.existsSync(candPath)) {
            try {
                const stat = fs.statSync(candPath);
                this.lastCandRegistryMtime = stat.mtimeMs;
                const reg = JSON.parse(fs.readFileSync(candPath, 'utf8'));
                if (Array.isArray(reg)) {
                    let newImports = 0;
                    for (const c of reg) {
                        if (c.status !== 'HOLDOUT_CONFIRMED' && c.status !== 'CONFIRMED') continue;
                        const existing = this.candidates.find((cand) => cand.id === c.id);
                        if (!existing) {
                            this.candidates.push({
                                id: c.id,
                                name: c.name,
                                target: c.target,
                                category: c.category || 'sequence',
                                status: 'LIVE_SHADOW', // New discoveries enter as live shadow
                                discovery: c.discovery || {},
                                oos: c.oos || {},
                                holdout: c.holdout || {},
                                liveStats: {
                                    triggeredCount: 0,
                                    wins: 0,
                                    losses: 0,
                                    consecutiveLosses: 0,
                                    currentLift: 0,
                                    evAccumulated: 0
                                },
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            });
                            newImports++;
                        }
                    }
                    if (newImports > 0 || !fs.existsSync(lifePath)) {
                        this.save();
                    }
                }
            } catch (err) {
                logger.warn(`SignalLifecycle [${this.siteId}]: could not auto-sync candidates: ${err.message}`);
            }
        }
    }

    refresh() {
        this.load();
        return this.getActiveSignals();
    }

    save() {
        try {
            if (!fs.existsSync(config.DATA_DIR)) {
                fs.mkdirSync(config.DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(this.getFilePath(), JSON.stringify(this.candidates, null, 2));
        } catch (err) {
            logger.error(`SignalLifecycle [${this.siteId}]: failed to save lifecycle: ${err.message}`);
        }
    }

    /**
     * Imports newly confirmed candidates from a hypothesis engine run.
     */
    importHoldoutConfirmed(confirmedCandidates) {
        if (!Array.isArray(confirmedCandidates)) return 0;
        let imported = 0;

        for (const c of confirmedCandidates) {
            if (c.status !== 'HOLDOUT_CONFIRMED' && c.status !== 'CONFIRMED') continue;
            const existing = this.candidates.find((cand) => cand.id === c.id);
            if (!existing) {
                this.candidates.push({
                    id: c.id,
                    name: c.name,
                    target: c.target,
                    status: 'LIVE_SHADOW', // Start in live shadow mode
                    discovery: c.discovery || {},
                    oos: c.oos || {},
                    holdout: c.holdout || {},
                    liveStats: {
                        triggeredCount: 0,
                        wins: 0,
                        losses: 0,
                        consecutiveLosses: 0,
                        currentLift: 0,
                        evAccumulated: 0
                    },
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                });
                imported++;
            }
        }

        if (imported > 0) this.save();
        return imported;
    }

    /**
     * Returns signals that are active for live evaluation or betting.
     */
    getActiveSignals() {
        this.checkHotReload();
        return this.candidates.filter((c) =>
            c.status === 'LIVE_SHADOW' ||
            c.status === 'LIVE_MICRO' ||
            c.status === 'HOLDOUT_CONFIRMED'
        );
    }

    /**
     * Checks if any active confirmed signal triggers on the current history state.
     */
    matchActiveSignals(history) {
        if (!Array.isArray(history) || history.length < 3) return [];
        const active = this.getActiveSignals();
        const matches = [];
        const t = history.length;

        for (const cand of active) {
            const def = this.hypMap.get(cand.id);
            if (def && typeof def.predicate === 'function') {
                try {
                    if (def.predicate(history, t)) {
                        matches.push({
                            id: cand.id,
                            name: cand.name,
                            target: cand.target,
                            status: cand.status,
                            holdoutHitRate: cand.holdout ? cand.holdout.hitRate : null,
                            holdoutEv: cand.holdout ? cand.holdout.evPerBet : null,
                            liveHitRate: cand.liveStats && cand.liveStats.triggeredCount > 0
                                ? cand.liveStats.wins / cand.liveStats.triggeredCount
                                : null
                        });
                    }
                } catch (err) {
                    // Predicate evaluation guard
                }
            }
        }

        return matches;
    }

    /**
     * Updates live shadow & micro tracking upon round completion.
     */
    onRoundEnded(historyBeforeRound, crashValue) {
        this.checkHotReload();
        if (!Array.isArray(historyBeforeRound) || historyBeforeRound.length < 3) return;
        const t = historyBeforeRound.length;
        let modified = false;

        for (const cand of this.candidates) {
            if (cand.status === 'RETIRED') continue;

            const def = this.hypMap.get(cand.id);
            if (!def || typeof def.predicate !== 'function') continue;

            const triggered = def.predicate(historyBeforeRound, t);
            if (!triggered) continue;

            if (!cand.liveStats) {
                cand.liveStats = {
                    triggeredCount: 0,
                    wins: 0,
                    losses: 0,
                    consecutiveLosses: 0,
                    currentLift: 0,
                    evAccumulated: 0
                };
            }

            const won = crashValue >= cand.target;
            cand.liveStats.triggeredCount++;
            if (won) {
                cand.liveStats.wins++;
                cand.liveStats.consecutiveLosses = 0;
                cand.liveStats.evAccumulated += (cand.target - 1);
            } else {
                cand.liveStats.losses++;
                cand.liveStats.consecutiveLosses++;
                cand.liveStats.evAccumulated -= 1;
            }

            const hitRate = cand.liveStats.wins / cand.liveStats.triggeredCount;
            const breakEven = 1 / cand.target;
            cand.liveStats.currentLift = Number((hitRate - breakEven).toFixed(4));
            cand.updatedAt = Date.now();
            modified = true;

            // ---- Lifecycle State Transitions (Strict Statistical Gating) ----
            const n = cand.liveStats.triggeredCount;
            const wins = cand.liveStats.wins;
            const wLower = wilsonLowerBound(wins, n);
            const pVal = hitRatePValue(wins, n, breakEven);

            // 1. Promotion: LIVE_SHADOW -> LIVE_MICRO
            // Requires sample >= MIN_SHADOW_BETS, positive cumulative EV, Wilson lower bound >= break-even, and p < 0.05
            if (cand.status === 'LIVE_SHADOW' &&
                n >= MIN_SHADOW_BETS_FOR_PROMOTION &&
                cand.liveStats.evAccumulated > 0 &&
                (wLower >= breakEven || pVal < 0.05) &&
                cand.liveStats.currentLift > 0.02) {
                cand.status = 'LIVE_MICRO';
                logger.info(`SignalLifecycle [${this.siteId}]: PROMOTED signal "${cand.name}" to LIVE_MICRO (N=${n}, winRate=${(hitRate * 100).toFixed(1)}%, evAccum=+${cand.liveStats.evAccumulated.toFixed(2)}, p=${pVal.toFixed(3)})`);
            }

            // 2. Drift Warning: LIVE_MICRO / LIVE_SHADOW -> DRIFTING
            if ((cand.status === 'LIVE_MICRO' || cand.status === 'LIVE_SHADOW') &&
                n >= 20 &&
                (cand.liveStats.currentLift < DRIFT_LIFT_TOLERANCE || cand.liveStats.evAccumulated < 0)) {
                cand.status = 'DRIFTING';
                logger.warn(`SignalLifecycle [${this.siteId}]: DRIFT DETECTED for signal "${cand.name}" (lift ${(cand.liveStats.currentLift * 100).toFixed(1)}% < ${DRIFT_LIFT_TOLERANCE * 100}%, evAccum=${cand.liveStats.evAccumulated.toFixed(2)})`);
            }

            // 3. Retirement: DRIFTING -> RETIRED
            if (cand.status === 'DRIFTING' &&
                (cand.liveStats.consecutiveLosses >= MAX_CONSECUTIVE_SIGNAL_LOSSES ||
                 cand.liveStats.evAccumulated <= -2.0 ||
                 (n >= 35 && cand.liveStats.currentLift < DRIFT_LIFT_TOLERANCE))) {
                cand.status = 'RETIRED';
                logger.warn(`SignalLifecycle [${this.siteId}]: RETIRED decayed signal "${cand.name}" (evAccum=${cand.liveStats.evAccumulated.toFixed(2)})`);
            }
        }

        if (modified) this.save();
    }
}

module.exports = {
    SignalLifecycle,
    MIN_SHADOW_BETS_FOR_PROMOTION,
    MAX_CONSECUTIVE_SIGNAL_LOSSES,
    DRIFT_LIFT_TOLERANCE
};
