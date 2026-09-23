const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');

/**
 * Pattern detector over recent round clusters.
 *
 * Rounds are symbolized into bins (default: L < 1.5x, M 1.5-2.5x, H >= 2.5x)
 * and the detector mines what historically followed the LAST k symbols, for
 * k in {10, 5, 3}. It carries a prediction for the next round:
 * P(next crash >= target | this pattern) with Laplace smoothing.
 *
 * Patterns are never trusted blindly:
 *  - a pattern needs `minSupport` observations before it can fire
 *  - longer (more specific) patterns win over shorter ones
 *  - a pattern that keeps failing in live use goes STALE and is benched
 *    until enough new data arrives ("they change — we use them until they
 *    change, then re-earn trust")
 *
 * State persists to data/patterns.json.
 */
class PatternDetector {
    constructor(options = {}) {
        this.lengths = options.lengths || [10, 5, 3];
        this.minSupport = options.minSupport ?? 5;
        this.targetMultiplier = options.targetMultiplier ?? 1.5;
        this.bins = options.bins || [1.5, 2.5];
        this.staleAfterFails = options.staleAfterFails ?? 3;
        this.staleBenchRounds = options.staleBenchRounds ?? 200;
        this.file = options.file || null;

        this.stream = [];          // symbol history
        this.roundIndex = 0;
        this.patterns = new Map(); // "len:symbols" -> stats
    }

    // ------------------------------------------------------------------
    symbol(crash) {
        if (!Number.isFinite(crash)) return '?';
        if (crash < this.bins[0]) return 'L';
        if (crash < this.bins[1]) return 'M';
        return 'H';
    }

    key(len, symbols) {
        return `${len}:${symbols}`;
    }

    getPattern(key) {
        if (!this.patterns.has(key)) {
            this.patterns.set(key, {
                seen: 0,
                success: 0,
                used: 0,
                liveWins: 0, // settled live bets won on this pattern
                recentUses: [], // last outcomes (true/false) when we bet on it
                staleUntilRound: 0,
                lastSeenRound: 0
            });
        }
        return this.patterns.get(key);
    }

    /**
     * Feeds a completed round: updates every pattern that ENDED right before
     * this round, so each pattern learns what came next.
     */
    observe(crash) {
        const success = Number.isFinite(crash) && crash >= this.targetMultiplier;
        for (const len of this.lengths) {
            if (this.stream.length >= len) {
                const suffix = this.stream.slice(-len).join('');
                const p = this.getPattern(this.key(len, suffix));
                p.seen++;
                if (success) p.success++;
                p.lastSeenRound = this.roundIndex;
            }
        }
        this.stream.push(this.symbol(crash));
        if (this.stream.length > 5000) this.stream.shift();
        this.roundIndex++;
        this.save();
    }

    /**
     * Matches the current suffix against known patterns.
     * Prefers the LONGEST pattern with enough support.
     */
    detect() {
        const sorted = [...this.lengths].sort((a, b) => b - a);
        for (const len of sorted) {
            if (this.stream.length < len) continue;
            const suffix = this.stream.slice(-len).join('');
            const p = this.patterns.get(this.key(len, suffix));
            if (!p || p.seen < this.minSupport) continue;
            if (this.roundIndex < p.staleUntilRound) continue; // benched

            const probability = (p.success + 1) / (p.seen + 2); // Laplace
            const quality = Math.min(1, p.seen / (this.minSupport * 4));
            return {
                found: true,
                length: len,
                pattern: suffix,
                seen: p.seen,
                probability,
                quality,
                // LIVE track record — how often this pattern's bets actually
                // won in production (the guard against in-sample-only trust).
                used: p.used || 0,
                liveWins: p.liveWins || 0,
                liveWinRate: (p.used || 0) > 0 ? (p.liveWins || 0) / p.used : null,
                risky: probability < 0.45
            };
        }
        return { found: false, probability: null, quality: 0, risky: false };
    }

    /**
     * Feedback when a bet placed on this pattern settles.
     * Three consecutive failed uses bench the pattern.
     */
    recordUsageOutcome(detection, won) {
        if (!detection || !detection.found) return;
        const p = this.patterns.get(this.key(detection.length, detection.pattern));
        if (!p) return;
        p.used++;
        if (won) p.liveWins = (p.liveWins || 0) + 1;
        p.recentUses.push(!!won);
        if (p.recentUses.length > 5) p.recentUses.shift();
        const tail = p.recentUses.slice(-this.staleAfterFails);
        if (tail.length === this.staleAfterFails && tail.every((w) => !w)) {
            p.staleUntilRound = this.roundIndex + this.staleBenchRounds;
            logger.warn(
                `Pattern "${detection.pattern}" (len ${detection.length}) failed ` +
                `${this.staleAfterFails} uses in a row — benched for ${this.staleBenchRounds} rounds`
            );
        }
        this.save();
    }

    // ------------------------------------------------------------------
    snapshot() {
        const current = this.detect();
        // Strongest known pattern families (enough support), most-seen first —
        // this is what the live learning dashboard displays.
        const topPatterns = [...this.patterns.entries()]
            .filter(([, v]) => v.seen >= this.minSupport)
            .sort((a, b) => b[1].seen - a[1].seen)
            .slice(0, 8)
            .map(([key, v]) => {
                const sep = key.indexOf(':');
                return {
                    length: parseInt(key.slice(0, sep), 10),
                    pattern: key.slice(sep + 1),
                    seen: v.seen,
                    used: v.used,
                    probability: (v.success + 1) / (v.seen + 2),
                    benched: this.roundIndex < v.staleUntilRound
                };
            });
        return {
            roundsObserved: this.roundIndex,
            knownPatterns: this.patterns.size,
            supportedPatterns: topPatterns.length,
            topPatterns,
            current: current.found ? {
                pattern: current.pattern,
                length: current.length,
                seen: current.seen,
                probability: current.probability,
                quality: current.quality,
                risky: current.risky
            } : null
        };
    }

    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const obj = { roundIndex: this.roundIndex, patterns: {} };
            for (const [k, v] of this.patterns.entries()) obj.patterns[k] = v;
            fs.writeFileSync(this.file, JSON.stringify(obj));
        } catch (error) {
            logger.warn(`Could not persist patterns: ${error.message}`);
        }
    }

    static load(file, options = {}) {
        const detector = new PatternDetector({ ...options, file });
        try {
            if (file && fs.existsSync(file)) {
                const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
                detector.roundIndex = saved.roundIndex | 0;
                for (const [k, v] of Object.entries(saved.patterns || {})) {
                    detector.patterns.set(k, v);
                }
            }
        } catch (error) {
            logger.warn(`Could not load patterns (${error.message}) — starting fresh`);
        }
        return detector;
    }

    /**
     * Rebuilds the symbol stream from raw crash values (used at startup so
     * detect() works immediately from stored history).
     */
    rebuildStream(values) {
        this.stream = values.map((v) => this.symbol(v)).slice(-5000);
    }
}

module.exports = PatternDetector;
