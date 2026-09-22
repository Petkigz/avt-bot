#!/usr/bin/env node
/**
 * Model evaluation harness — the honest way to know if the prediction
 * engine is actually good.
 *
 * Runs the entry gate against SYNTHETIC Aviator rounds drawn from the real
 * crash distribution with a 3% house edge (crash = max(1, 0.97 / U)), so
 * the ground truth is KNOWN: no strategy has a long-run edge. The harness
 * measures what the engine CAN deliver: fewer bad entries, smaller
 * drawdowns, disciplined behavior — compared across engine generations.
 *
 * Usage: npm run model:eval
 */
process.env.LOG_LEVEL = 'error'; // quiet regime chatter during batch eval
const Predictor = require('../game/predictor');

const TARGET = 1.3;
const STAKE = 100;
const WARMUP = 150;
const ROUNDS = 20000;
const SEEDS = [7, 42, 1337, 20260922, 99];

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Standard crash-game distribution with house edge e: P(crash >= x) = (1-e)/x
function syntheticCrash(rng, edge = 0.03) {
    const u = rng();
    return Math.max(1, (1 - edge) / u);
}

function makePredictor() {
    return new Predictor({
        targetMultiplier: TARGET,
        minSampleSize: WARMUP,
        minEntryProbability: 0.60,
        maxEntryProbability: 0.85,
        coldStreakLimit: 3,
        coldRecoveryCount: 1,
        recencyHalfLife: 250,
        recentWindow: 100,
        wilsonCushion: 0.05
    });
}

function run(variant, seed) {
    const rng = mulberry32(seed);
    const p = makePredictor();
    let bankroll = 10000;
    let peak = bankroll;
    let maxDD = 0;
    let bets = 0;
    let wins = 0;

    for (let i = 0; i < ROUNDS; i++) {
        const crash = syntheticCrash(rng);

        // Decide BEFORE observing this round (we bet on the upcoming one).
        if (p.history.length >= WARMUP && !p.paused) {
            let allowed = false;
            let conf = null;
            if (variant === 'classic') {
                conf = p.probCrashAtLeast(TARGET);
                allowed = conf !== null && conf >= p.entryProbability;
            } else {
                conf = p.blendedProbability(TARGET);
                allowed = conf !== null && conf >= p.entryProbability;
                if (allowed) {
                    const lb = p.wilsonLower(TARGET);
                    if (lb !== null && lb + p.wilsonCushion < p.entryProbability) allowed = false;
                }
            }
            if (allowed) {
                bets++;
                if (crash >= TARGET) { wins++; bankroll += STAKE * (TARGET - 1); }
                else bankroll -= STAKE;
                peak = Math.max(peak, bankroll);
                maxDD = Math.max(maxDD, peak - bankroll);
                p.recordOutcome(crash >= TARGET);
            }
        }
        p.addRound(crash); // learns + cold-regime pausing
    }
    return { final: bankroll, maxDD, bets, hitRate: bets > 0 ? wins / bets : 0 };
}

function summarize(label, results) {
    const n = results.length;
    const avg = (f) => results.reduce((a, r) => a + f(r), 0) / n;
    console.log(
        `${label.padEnd(10)} avg final: ${avg((r) => r.final).toFixed(0).padStart(7)}  ` +
        `avg max drawdown: ${avg((r) => r.maxDD).toFixed(0).padStart(6)}  ` +
        `avg bets: ${avg((r) => r.bets).toFixed(0).padStart(5)}  ` +
        `avg hit rate: ${(avg((r) => r.hitRate) * 100).toFixed(1)}%`
    );
}

console.log(`Synthetic Aviator feed: ${ROUNDS} rounds x ${SEEDS.length} seeds, 3% house edge, target ${TARGET}x, flat stake ${STAKE}\n`);
const classic = SEEDS.map((s) => run('classic', s));
const upgraded = SEEDS.map((s) => run('upgraded', s));
summarize('classic', classic);
summarize('upgraded', upgraded);

const theo = (1 - 0.03) / TARGET;
console.log(`\nTheoretical P(crash >= ${TARGET}) with 3% edge: ${(theo * 100).toFixed(1)}% — every flat-stake system is negative-EV by design.`);
console.log('The engine cannot beat the RNG; it can only reduce how often it enters bad rounds and how deep drawdowns get.');
console.log('Read the table as: fewer bets at similar hit rate + smaller drawdown = better discipline, not a magic edge.');
