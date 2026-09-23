'use strict';

/**
 * recalibrator.js — the engine learning the honesty of its OWN judgment.
 *
 * Intelligence upgrade #1: adaptive probability self-repair.
 *
 * The predictor outputs a confidence for every round (e.g. 0.72 that the
 * crash reaches the target). Over time those confidences may be
 * systematically wrong — too bold after wins, too shy after losses, or
 * simply miscalibrated for the current feed. This module studies how the
 * engine's past predictions ACTUALLY settled and builds a correction map:
 *
 *   "when the model says ~0.7, reality settles at 0.63 → trust 0.63"
 *
 * Method: histogram recalibration with Bayesian shrinkage. Predictions are
 * binned; each bin's corrected probability is the observed hit rate pulled
 * toward the global base rate in proportion to how little data the bin has.
 * No parametric assumptions, no overfitting: with little data the map is a
 * pass-through; with much data it converges to the empirical truth.
 *
 * Honesty rules baked in:
 *   - The map only activates after MIN_SETTLED settled predictions
 *     (default 100). Before that, adjust() is a strict pass-through.
 *   - The map is trained on settled history and applied to NEW rounds; it
 *     can only REMOVE false confidence, never manufacture signal — if the
 *     stream is random it converges to the base rate and gates bet less.
 *   - Since activation, it tracks the Brier score of its OWN corrected
 *     probabilities on new rounds, so "raw vs corrected" is visible and
 *     auditable (a corrected layer that performs worse than raw should be
 *     switched off — snapshot() exposes the comparison).
 */

const fs = require('fs');

class Recalibrator {
    constructor(options = {}) {
        this.file = options.file || null;
        this.bins = Math.max(4, options.bins || 10);
        this.minSettled = Math.max(20, options.minSettled || 100);
        this.shrinkage = options.shrinkage ?? 12;   // pseudo-counts toward the base rate
        this.maxStore = options.maxStore || 3000;

        this.settled = [];              // {p, y} rolling store (map source)
        this.hits = new Array(this.bins).fill(0);
        this.counts = new Array(this.bins).fill(0);
        this.totalHits = 0;
        this.total = 0;

        // Since-activation audit: corrected probability assigned BEFORE the
        // round settled vs the actual outcome.
        this.auditN = 0;
        this.auditRawBrierSum = 0;
        this.auditAdjBrierSum = 0;
        this._pendingAudit = null;      // {raw, adj} for the round in flight
    }

    get ready() {
        return this.total >= this.minSettled;
    }

    binOf(p) {
        const i = Math.floor(p * this.bins);
        return Math.min(this.bins - 1, Math.max(0, i));
    }

    baseRate() {
        return this.total > 0 ? this.totalHits / this.total : 0.5;
    }

    /** Corrected probability for a bin: observed rate shrunk toward the
     *  global base rate when the bin has little evidence. */
    binRate(i) {
        const n = this.counts[i];
        if (n === 0) return this.baseRate();
        const observed = this.hits[i] / n;
        return (this.hits[i] + this.shrinkage * this.baseRate()) / (n + this.shrinkage);
    }

    /** Map a raw model probability to the corrected one. Strict pass-through
     *  until enough predictions have settled. */
    adjust(p) {
        if (!Number.isFinite(p)) return p;
        if (!this.ready) return p;
        const clamped = Math.min(1, Math.max(0, p));
        return Math.min(0.999, Math.max(0.001, this.binRate(this.binOf(clamped))));
    }

    /** Feed one settled prediction (raw probability + actual outcome). */
    update(raw, outcome) {
        if (!Number.isFinite(raw) || raw < 0 || raw > 1) return false;
        const y = outcome ? 1 : 0;
        const p = Math.min(1, Math.max(0, raw));

        // Audit the correction that was in force for this round BEFORE it
        // settled (this is the honest, out-of-sample number).
        if (this._pendingAudit !== null && this.ready) {
            const { raw: rp, adj } = this._pendingAudit;
            this.auditN += 1;
            this.auditRawBrierSum += (rp - y) ** 2;
            this.auditAdjBrierSum += (adj - y) ** 2;
        }
        this._pendingAudit = null;

        const i = this.binOf(p);
        this.hits[i] += y;
        this.counts[i] += 1;
        this.totalHits += y;
        this.total += 1;
        this.settled.push({ p, y });
        if (this.settled.length > this.maxStore) {
            const dropped = this.settled.shift();
            const di = this.binOf(dropped.p);
            this.hits[di] -= dropped.y;
            this.counts[di] -= 1;
            this.totalHits -= dropped.y;
            this.total -= 1;
        }
        return true;
    }

    /** Call BEFORE the next round starts so the in-flight correction is the
     *  one that was in force when the prediction was made. */
    notePending(raw) {
        this._pendingAudit = Number.isFinite(raw) ? { raw, adj: this.adjust(raw) } : null;
    }

    snapshot() {
        const brierRaw = this.auditN > 0 ? this.auditRawBrierSum / this.auditN : null;
        const brierAdj = this.auditN > 0 ? this.auditAdjBrierSum / this.auditN : null;
        return {
            settled: this.total,
            minSettled: this.minSettled,
            ready: this.ready,
            baseRate: this.total > 0 ? Number(this.baseRate().toFixed(4)) : null,
            auditRounds: this.auditN,
            brierRaw: brierRaw !== null ? Number(brierRaw.toFixed(5)) : null,
            brierAdjusted: brierAdj !== null ? Number(brierAdj.toFixed(5)) : null,
            helping: brierRaw !== null && brierAdj !== null ? brierAdj <= brierRaw : null
        };
    }

    toJSON() {
        return {
            bins: this.bins, minSettled: this.minSettled, shrinkage: this.shrinkage,
            settled: this.settled, auditN: this.auditN,
            auditRawBrierSum: this.auditRawBrierSum, auditAdjBrierSum: this.auditAdjBrierSum
        };
    }

    load() {
        if (!this.file) return false;
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.hits = new Array(this.bins).fill(0);
            this.counts = new Array(this.bins).fill(0);
            this.totalHits = 0;
            this.total = 0;
            this.settled = [];
            for (const s of raw.settled || []) this.update(s.p, s.y);
            this.auditN = raw.auditN | 0;
            this.auditRawBrierSum = Number(raw.auditRawBrierSum) || 0;
            this.auditAdjBrierSum = Number(raw.auditAdjBrierSum) || 0;
            return true;
        } catch (error) { return false; }
    }

    save() {
        if (!this.file) return false;
        try { fs.writeFileSync(this.file, JSON.stringify(this.toJSON())); return true; }
        catch (error) { return false; }
    }
}

module.exports = Recalibrator;
