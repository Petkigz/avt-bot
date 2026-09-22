'use strict';

/**
 * CalibrationTracker — measures whether predicted probabilities mean what
 * they claim. If the engine says "0.75 confidence" on 200 rounds, roughly
 * 150 of them should win; anything else means the confidence is lying.
 *
 * Metrics:
 *   - Brier score   (mean squared error of probabilities; lower is better,
 *                    0 = perfect)
 *   - log loss      (harsh on confident wrong calls; lower is better)
 *   - ECE           (expected calibration error: sample-weighted average
 *                    gap between predicted probability and actual hit rate
 *                    per bin)
 *   - bins          (the calibration curve as data)
 */
class CalibrationTracker {
    constructor(options = {}) {
        this.binCount = Math.max(2, options.bins || 10);
        this.predictions = []; // {p, y}
    }

    /** Record one settled prediction. `predicted` in [0,1], `outcome` 0/1. */
    record(predicted, outcome) {
        if (!Number.isFinite(predicted) || predicted < 0 || predicted > 1) return false;
        const y = outcome ? 1 : 0;
        // clamp away from 0/1 so log loss stays finite
        const p = Math.min(1 - 1e-6, Math.max(1e-6, predicted));
        this.predictions.push({ p, y });
        return true;
    }

    get count() {
        return this.predictions.length;
    }

    stats() {
        const n = this.predictions.length;
        if (n === 0) {
            return { count: 0, brier: null, logLoss: null, ece: null, bins: [] };
        }
        let brier = 0;
        let logLoss = 0;
        const bins = Array.from({ length: this.binCount }, (_, i) => ({
            lo: i / this.binCount,
            hi: (i + 1) / this.binCount,
            n: 0,
            sumPred: 0,
            sumOutcome: 0
        }));
        for (const { p, y } of this.predictions) {
            brier += (p - y) * (p - y);
            logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
            const idx = Math.min(this.binCount - 1, Math.floor(p * this.binCount));
            bins[idx].n += 1;
            bins[idx].sumPred += p;
            bins[idx].sumOutcome += y;
        }
        let ece = 0;
        const curve = [];
        for (const bin of bins) {
            if (bin.n === 0) {
                curve.push({ lo: bin.lo, hi: bin.hi, n: 0, avgPredicted: null, actualRate: null });
                continue;
            }
            const avgPred = bin.sumPred / bin.n;
            const actualRate = bin.sumOutcome / bin.n;
            ece += (bin.n / n) * Math.abs(avgPred - actualRate);
            curve.push({
                lo: bin.lo,
                hi: bin.hi,
                n: bin.n,
                avgPredicted: Number(avgPred.toFixed(4)),
                actualRate: Number(actualRate.toFixed(4))
            });
        }
        return {
            count: n,
            brier: Number((brier / n).toFixed(5)),
            logLoss: Number((logLoss / n).toFixed(5)),
            ece: Number(ece.toFixed(5)),
            bins: curve
        };
    }

    /** One-line human summary for logs. */
    summary() {
        const s = this.stats();
        if (s.count === 0) return 'no settled predictions yet';
        return (
            `${s.count} settled predictions | Brier ${s.brier} | logLoss ${s.logLoss} | ECE ${s.ece}`
        );
    }
}

module.exports = CalibrationTracker;
