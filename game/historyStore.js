const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');

/**
 * Persistent round-crash history — the bot's long-term MEMORY.
 * Values survive restarts (data/history.json) so the model keeps learning
 * across sessions instead of starting blind every time.
 */
class HistoryStore {
    constructor(file, maxEntries = 5000) {
        this.file = file;
        this.maxEntries = maxEntries;
        this.values = [];
        this.dedupeSameValueMs = 4000; // parallel-monitor duplicate guard
        this.lastAppendedValue = null;
        this.lastAppendedAt = null;
    }

    /**
     * Loads previously stored rounds. Returns how many were loaded.
     */
    load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (Array.isArray(raw)) {
                    this.values = raw
                        .filter((v) => Number.isFinite(v) && v > 0)
                        .slice(-this.maxEntries);
                }
            }
        } catch (error) {
            logger.warn(`Could not load history (${error.message}) — starting fresh`);
            this.values = [];
        }
        return this.values.length;
    }

    /**
     * Appends a crash value and persists immediately (write-through).
     * Parallel monitors all watch the SAME global Aviator feed, so the same
     * round arrives from several sessions within milliseconds — identical
     * values landing inside `dedupeSameValueMs` of each other are dropped.
     * (Genuine consecutive identical crashes are always a full round apart,
     * ~10s+ minimum, so a 4s window is safe.)
     */
    append(value, { force = false } = {}) {
        if (!Number.isFinite(value) || value <= 0) return false;
        const now = Date.now();
        if (!force && this.lastAppendedValue === value &&
            this.lastAppendedAt !== null &&
            now - this.lastAppendedAt < this.dedupeSameValueMs) {
            return false; // same global round, second monitor reporting it
        }
        this.lastAppendedValue = value;
        this.lastAppendedAt = now;
        this.values.push(value);
        if (this.values.length > this.maxEntries) this.values.shift();
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.values));
        } catch (error) {
            logger.warn(`Could not persist history: ${error.message}`);
        }
        return true;
    }

    size() {
        return this.values.length;
    }
}

module.exports = HistoryStore;
