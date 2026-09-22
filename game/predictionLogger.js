'use strict';

const fs = require('fs');
const path = require('path');

/**
 * PredictionLogger — permanent, append-only JSONL record of every
 * prediction the engine makes and how it settled. This is the raw
 * material for calibration analysis, walk-forward validation and
 * error studies; nothing is ever overwritten.
 *
 * Line kinds:
 *   {kind:'predict', ts, site, target, prob, threshold, allowed, tier, regime}
 *   {kind:'settle',  ts, site, target, prob, crash, won}
 */
class PredictionLogger {
    constructor(file) {
        this.file = file;
    }

    log(record) {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
            return true;
        } catch (error) {
            return false; // logging must never take the bot down
        }
    }

    logPrediction(fields) {
        return this.log({ kind: 'predict', ts: Date.now(), ...fields });
    }

    logOutcome(fields) {
        return this.log({ kind: 'settle', ts: Date.now(), ...fields });
    }

    /** Read back all valid records (tolerates torn/corrupt lines). */
    readAll() {
        try {
            if (!fs.existsSync(this.file)) return [];
            const lines = fs.readFileSync(this.file, 'utf8').split('\n');
            const out = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    out.push(JSON.parse(trimmed));
                } catch (error) { /* skip corrupt line */ }
            }
            return out;
        } catch (error) {
            return [];
        }
    }

    /** Settled (predict+outcome) pairs usable by validation tools. */
    settledPairs() {
        return this.readAll().filter((r) => r.kind === 'settle' && Number.isFinite(r.prob));
    }
}

module.exports = PredictionLogger;
