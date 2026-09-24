'use strict';

/**
 * game/ensemble.js
 *
 * Calibrated Multi-Source Probability Ensemble Engine.
 *
 * Rather than a brittle if/else waterfall, unifies multiple distinct intelligence streams:
 * 1. Statistical Estimator (Recent window / base rate)
 * 2. Supervised Feature Model (Logistic / Boosting from Tournament)
 * 3. Confirmed Hypothesis Signals (Mined & holdout-validated patterns/streaks/timing)
 * 4. Microstructure Trajectory Models (Early flight curve dynamics)
 *
 * Combines calibrated log-odds with precision/skill weighting to produce an
 * optimal, variance-reduced posterior probability P(outcome >= target).
 */

const EPS = 1e-4;

function logit(p) {
    const clamped = Math.min(1 - EPS, Math.max(EPS, p));
    return Math.log(clamped / (1 - clamped));
}

function sigmoid(z) {
    const clamped = Math.max(-20, Math.min(20, z));
    return 1 / (1 + Math.exp(-clamped));
}

/**
 * Blends multiple probability inputs into an optimal calibrated ensemble prediction.
 *
 * @param {Array<{ name: string, prob: number, weight: number, kind: string }>} sources
 * @returns {{ probability: number, sourcesUsed: string[], weights: Record<string, number>, logit: number }}
 */
function blendEnsemble(sources) {
    const valid = (sources || []).filter((s) => s && Number.isFinite(s.prob) && s.prob > 0 && s.prob < 1);

    if (valid.length === 0) {
        return {
            probability: null,
            sourcesUsed: [],
            weights: {},
            logit: 0
        };
    }

    if (valid.length === 1) {
        return {
            probability: Number(valid[0].prob.toFixed(4)),
            sourcesUsed: [valid[0].name],
            weights: { [valid[0].name]: 1.0 },
            logit: Number(logit(valid[0].prob).toFixed(4))
        };
    }

    let totalWeight = 0;
    let weightedLogitSum = 0;
    const weightsMap = {};

    for (const s of valid) {
        const w = Math.max(0.1, s.weight || 1.0);
        const l = logit(s.prob);
        weightedLogitSum += w * l;
        totalWeight += w;
        weightsMap[s.name] = Number(w.toFixed(2));
    }

    const ensembleLogit = weightedLogitSum / (totalWeight || 1);
    const ensembleProb = sigmoid(ensembleLogit);

    return {
        probability: Number(ensembleProb.toFixed(4)),
        sourcesUsed: valid.map((s) => s.name),
        weights: weightsMap,
        logit: Number(ensembleLogit.toFixed(4))
    };
}

module.exports = {
    logit,
    sigmoid,
    blendEnsemble
};
