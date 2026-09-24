'use strict';

/**
 * sim/syntheticWorlds.js
 *
 * Adversarial Synthetic Research Proving Ground.
 * Generates controlled synthetic Aviator crash streams with known statistical
 * and microstructure properties to benchmark the entire scientific discovery stack.
 */

const { symbolOf } = require('../game/features');

function makeRng(seed = 4242) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * World 1: Pure IID Aviator Distribution
 * CDF: P(X >= x) = 0.95 / x for x >= 1.01. Instant crash 5%.
 */
function createWorld1_PureIid(n = 1000, seed = 101) {
    const rng = makeRng(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        const u = rng();
        if (u < 0.05) out.push(1.00);
        else {
            const v = (u - 0.05) / 0.95;
            out.push(Math.max(1.01, Number((1 / (1 - v + 1e-9)).toFixed(2))));
        }
    }
    return out;
}

/**
 * World 2: First-Order Markov Transition Dependency
 * High rounds (>2.5x) tend to follow high rounds with 75% probability.
 */
function createWorld2_MarkovDependency(n = 1000, seed = 202) {
    const rng = makeRng(seed);
    const out = [];
    let state = 0; // 0 = low (<1.5x), 1 = high (>2.5x)
    for (let i = 0; i < n; i++) {
        if (rng() < 0.25) state = 1 - state; // 75% persistence
        if (state === 0) {
            out.push(Number((1.05 + rng() * 0.40).toFixed(2))); // [1.05, 1.45]
        } else {
            out.push(Number((2.60 + rng() * 5.00).toFixed(2))); // [2.60, 7.60]
        }
    }
    return out;
}

/**
 * World 3: Hidden Regime Switching
 * Stream flips between a cold regime (P(X>=1.5)=0.35) and a hot rocket regime (P(X>=1.5)=0.85)
 * every 80-120 rounds.
 */
function createWorld3_RegimeSwitching(n = 1200, seed = 303) {
    const rng = makeRng(seed);
    const out = [];
    let regime = 0; // 0 = cold, 1 = hot
    let blockLen = 80 + Math.floor(rng() * 40);
    let blockCount = 0;

    for (let i = 0; i < n; i++) {
        blockCount++;
        if (blockCount >= blockLen) {
            regime = 1 - regime;
            blockLen = 80 + Math.floor(rng() * 40);
            blockCount = 0;
        }

        if (regime === 0) {
            out.push(rng() < 0.65 ? Number((1.01 + rng() * 0.45).toFixed(2)) : Number((1.50 + rng() * 2.0).toFixed(2)));
        } else {
            out.push(rng() < 0.85 ? Number((2.00 + rng() * 6.0).toFixed(2)) : Number((1.10 + rng() * 0.3).toFixed(2)));
        }
    }
    return out;
}

/**
 * World 4: Microstructure Flight Trajectory Dependency
 * In-flight timeTo12 correlates with probability of surviving to 2.0x.
 */
function createWorld4_TrajectoryTraces(n = 400, seed = 404) {
    const rng = makeRng(seed);
    const traces = [];

    for (let i = 0; i < n; i++) {
        const isFast = rng() < 0.50;
        const timeTo12 = isFast ? 150 + Math.floor(rng() * 100) : 600 + Math.floor(rng() * 200);
        const willSurvive20 = isFast ? rng() < 0.75 : rng() < 0.25;
        const crash = willSurvive20
            ? Number((2.20 + rng() * 4.0).toFixed(2))
            : Number((1.05 + rng() * 0.40).toFixed(2));
        const durationMs = Math.round((crash - 1.0) * 1200 + 400);

        traces.push({
            roundId: i + 1,
            site: 'synthetic',
            crash,
            durationMs,
            timeTo12,
            timeTo15: crash >= 1.50 ? timeTo12 + 200 : null,
            timeTo20: crash >= 2.00 ? timeTo12 + 500 : null,
            interRoundIntervalMs: 3000 + Math.floor(rng() * 2000),
            samples: [
                { t: 0, v: 1.00 },
                { t: timeTo12, v: 1.20 },
                { t: durationMs, v: crash }
            ],
            ts: 1700000000000 + i * 15000
        });
    }
    return traces;
}

/**
 * World 5: Genuine Specific Conditional Pattern Signal
 * Whenever pattern 'LLH' appears, the next round has a 95% probability of surviving 1.50x.
 */
function createWorld5_PatternSignal(n = 2400, seed = 505) {
    const rng = makeRng(seed);
    const out = [];

    for (let i = 0; i < n; i++) {
        if (i >= 3 && symbolOf(out[i - 3]) === 'L' && symbolOf(out[i - 2]) === 'L' && symbolOf(out[i - 1]) === 'H') {
            // Strong genuine signal: 95% hit rate on 1.50x
            out.push(rng() < 0.95 ? Number((1.55 + rng() * 3.0).toFixed(2)) : Number((1.05 + rng() * 0.3).toFixed(2)));
        } else {
            // Standard IID Aviator baseline
            const u = rng();
            if (u < 0.05) out.push(1.00);
            else {
                const v = (u - 0.05) / 0.95;
                out.push(Math.max(1.01, Number((1 / (1 - v + 1e-9)).toFixed(2))));
            }
        }
    }
    return out;
}

/**
 * World 6: Transient / Decaying Pattern Signal
 * A pattern that works in the first 600 rounds, then decays in the remaining rounds.
 */
function createWorld6_DecayingSignal(n = 1500, seed = 606) {
    const rng = makeRng(seed);
    const out = [];

    for (let i = 0; i < n; i++) {
        const inActiveWindow = i < 600;
        if (inActiveWindow && i >= 3 && symbolOf(out[i - 3]) === 'L' && symbolOf(out[i - 2]) === 'L' && symbolOf(out[i - 1]) === 'H') {
            out.push(rng() < 0.92 ? Number((1.60 + rng() * 2.0).toFixed(2)) : 1.10);
        } else {
            const u = rng();
            if (u < 0.05) out.push(1.00);
            else {
                const v = (u - 0.05) / 0.95;
                out.push(Math.max(1.01, Number((1 / (1 - v + 1e-9)).toFixed(2))));
            }
        }
    }
    return out;
}

module.exports = {
    createWorld1_PureIid,
    createWorld2_MarkovDependency,
    createWorld3_RegimeSwitching,
    createWorld4_TrajectoryTraces,
    createWorld5_PatternSignal,
    createWorld6_DecayingSignal
};
