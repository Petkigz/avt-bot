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
     */
    append(value) {
        if (!Number.isFinite(value) || value <= 0) return;
        this.values.push(value);
        if (this.values.length > this.maxEntries) this.values.shift();
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.values));
        } catch (error) {
            logger.warn(`Could not persist history: ${error.message}`);
        }
    }

    size() {
        return this.values.length;
    }
}

module.exports = HistoryStore;
