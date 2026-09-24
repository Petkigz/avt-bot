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

function brierScore(predictions, outcomes) {
    if (!predictions || !outcomes || predictions.length === 0 || predictions.length !== outcomes.length) {
        return null;
    }
    let sum = 0;
    for (let i = 0; i < predictions.length; i++) {
        const diff = predictions[i] - outcomes[i];
        sum += diff * diff;
    }
    return sum / predictions.length;
}

function logLoss(predictions, outcomes) {
    if (!predictions || !outcomes || predictions.length === 0 || predictions.length !== outcomes.length) {
        return null;
    }
    let sum = 0;
    for (let i = 0; i < predictions.length; i++) {
        const p = Math.min(1 - EPS, Math.max(EPS, predictions[i]));
        const y = outcomes[i];
        sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
    return sum / predictions.length;
}

/**
 * Optimizes ensemble weights over an out-of-sample or validation dataset
 * to minimize the empirical Brier score using coordinate search.
 *
 * @param {Array<{ probs: Record<string, number>, outcome: number }>} dataset
 * @param {string[]} sourceNames
 * @returns {{ weights: Record<string, number>, brier: number, baselineBrier: number }}
 */
function fitEnsembleWeights(dataset, sourceNames) {
    if (!Array.isArray(dataset) || dataset.length < 10 || !Array.isArray(sourceNames) || sourceNames.length === 0) {
        const defaultWeights = {};
        for (const nm of sourceNames || []) defaultWeights[nm] = 1.0;
        return { weights: defaultWeights, brier: 0.25, baselineBrier: 0.25 };
    }

    // Baseline Brier (simple average of sources)
    const outcomes = dataset.map((d) => d.outcome);
    const baselinePreds = dataset.map((d) => {
        let s = 0;
        let c = 0;
        for (const nm of sourceNames) {
            if (Number.isFinite(d.probs[nm])) {
                s += d.probs[nm];
                c++;
            }
        }
        return c > 0 ? s / c : 0.5;
    });
    const baselineBrier = brierScore(baselinePreds, outcomes);

    // Initialize weights
    const weights = {};
    for (const nm of sourceNames) weights[nm] = 1.0;

    // Coordinate descent optimization on logit weights
    const evaluate = (wObj) => {
        const preds = dataset.map((d) => {
            let totalW = 0;
            let sumL = 0;
            for (const nm of sourceNames) {
                const p = d.probs[nm];
                if (Number.isFinite(p) && p > 0 && p < 1) {
                    const w = Math.max(0.01, wObj[nm] || 0.1);
                    sumL += w * logit(p);
                    totalW += w;
                }
            }
            return totalW > 0 ? sigmoid(sumL / totalW) : 0.5;
        });
        return brierScore(preds, outcomes);
    };

    let bestBrier = evaluate(weights);

    // Optimize over 3 iterations across dimensions
    const stepSizes = [0.5, 0.2, 0.05];
    for (const step of stepSizes) {
        for (let iter = 0; iter < 4; iter++) {
            let improved = false;
            for (const nm of sourceNames) {
                const cur = weights[nm];
                // Try +step
                weights[nm] = Math.min(5.0, cur + step);
                const bUp = evaluate(weights);
                // Try -step
                weights[nm] = Math.max(0.1, cur - step);
                const bDown = evaluate(weights);

                if (bUp < bestBrier && bUp <= bDown) {
                    bestBrier = bUp;
                    weights[nm] = Math.min(5.0, cur + step);
                    improved = true;
                } else if (bDown < bestBrier) {
                    bestBrier = bDown;
                    weights[nm] = Math.max(0.1, cur - step);
                    improved = true;
                } else {
                    weights[nm] = cur;
                }
            }
            if (!improved) break;
        }
    }

    // Normalize weights so the min weight is >= 0.5
    const outWeights = {};
    for (const nm of sourceNames) {
        outWeights[nm] = Number(weights[nm].toFixed(2));
    }

    return {
        weights: outWeights,
        brier: Number(bestBrier.toFixed(5)),
        baselineBrier: Number(baselineBrier.toFixed(5))
    };
}

/**
 * Blends multiple probability inputs into an optimal calibrated ensemble prediction.
 *
 * @param {Array<{ name: string, prob: number, weight: number, kind: string }>} sources
 * @param {Record<string, number>} [learnedWeights] Optional learned weights dictionary
 * @returns {{ probability: number, sourcesUsed: string[], weights: Record<string, number>, logit: number }}
 */
function blendEnsemble(sources, learnedWeights = {}) {
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
        let w = s.weight || 1.0;
        if (learnedWeights && Number.isFinite(learnedWeights[s.name])) {
            w = learnedWeights[s.name];
        } else if (learnedWeights && s.kind && Number.isFinite(learnedWeights[s.kind])) {
            w = learnedWeights[s.kind];
        }
        w = Math.max(0.1, w);

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
    brierScore,
    logLoss,
    fitEnsembleWeights,
    blendEnsemble
};
