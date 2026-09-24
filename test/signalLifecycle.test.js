'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { SignalLifecycle } = require('../game/signalLifecycle');
const Brain = require('../game/brain');
const BettingStrategy = require('../game/strategies');
const Predictor = require('../game/predictor');
const PatternDetector = require('../game/patternDetector');
const Bankroll = require('../game/bankroll');

function cleanFile(f) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

test('signalLifecycle: imports holdout confirmed candidates into LIVE_SHADOW mode', () => {
    const site = 'test_site_lifecycle_1';
    const life = new SignalLifecycle(site);
    cleanFile(life.getFilePath());

    const count = life.importHoldoutConfirmed([
        {
            id: 'pattern_LLH_target_1.5',
            name: '3-Round Pattern "LLH" (Target 1.5x)',
            target: 1.50,
            status: 'HOLDOUT_CONFIRMED',
            holdout: { hitRate: 0.90, evPerBet: 0.35 }
        }
    ]);

    assert.strictEqual(count, 1);
    const active = life.getActiveSignals();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].status, 'LIVE_SHADOW');
    assert.strictEqual(active[0].id, 'pattern_LLH_target_1.5');
    cleanFile(life.getFilePath());
});

test('signalLifecycle: matchActiveSignals detects when condition matches history', () => {
    const site = 'test_site_lifecycle_2';
    const life = new SignalLifecycle(site);
    cleanFile(life.getFilePath());

    life.candidates = [
        {
            id: 'prior_low_crash_target_1.3',
            name: 'Previous crash was low (< 1.30x) (Target 1.3x)',
            target: 1.30,
            status: 'LIVE_MICRO',
            holdout: { hitRate: 0.85, evPerBet: 0.10 }
        }
    ];

    const historyMatches = [1.50, 2.00, 1.10]; // last round 1.10 is < 1.30
    const matches = life.matchActiveSignals(historyMatches);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].id, 'prior_low_crash_target_1.3');

    const historyNoMatch = [1.50, 2.00, 2.50]; // last round 2.50 is NOT < 1.30
    const noMatches = life.matchActiveSignals(historyNoMatch);
    assert.strictEqual(noMatches.length, 0);

    cleanFile(life.getFilePath());
});

test('signalLifecycle: promotes from LIVE_SHADOW to LIVE_MICRO on sustained positive lift', () => {
    const site = 'test_site_lifecycle_3';
    const life = new SignalLifecycle(site);
    cleanFile(life.getFilePath());

    life.candidates = [
        {
            id: 'prior_instant_crash_target_1.3',
            name: 'Previous instant (Target 1.3x)',
            target: 1.30,
            status: 'LIVE_SHADOW',
            liveStats: {
                triggeredCount: 29,
                wins: 26,
                losses: 3,
                consecutiveLosses: 0,
                currentLift: 0.12,
                evAccumulated: 4.8
            }
        }
    ];

    // Trigger round 30 with a win
    const historyBefore = [1.50, 2.00, 1.02];
    life.onRoundEnded(historyBefore, 1.45);

    const cand = life.candidates.find((c) => c.id === 'prior_instant_crash_target_1.3');
    assert.strictEqual(cand.status, 'LIVE_MICRO', 'candidate should be promoted to LIVE_MICRO after 30 qualifying rounds');
    cleanFile(life.getFilePath());
});

test('signalLifecycle: detects edge decay and retires signal after sustained underperformance', () => {
    const site = 'test_site_lifecycle_4';
    const life = new SignalLifecycle(site);
    cleanFile(life.getFilePath());

    life.candidates = [
        {
            id: 'prior_instant_crash_target_1.3',
            name: 'Previous instant (Target 1.3x)',
            target: 1.30,
            status: 'DRIFTING',
            liveStats: {
                triggeredCount: 35,
                wins: 15,
                losses: 20,
                consecutiveLosses: 8,
                currentLift: -0.15,
                evAccumulated: -5.5
            }
        }
    ];

    const historyBefore = [1.50, 2.00, 1.02];
    life.onRoundEnded(historyBefore, 1.10); // Loss

    const cand = life.candidates.find((c) => c.id === 'prior_instant_crash_target_1.3');
    assert.strictEqual(cand.status, 'RETIRED', 'decayed signal should transition to RETIRED');
    cleanFile(life.getFilePath());
});

test('Brain: evaluates active confirmed hypothesis signals in evaluateEntry', () => {
    const site = 'test_site_brain_hypothesis';
    const life = new SignalLifecycle(site);
    cleanFile(life.getFilePath());

    life.candidates = [
        {
            id: 'prior_low_crash_target_1.3',
            name: 'Previous crash low (Target 1.3x)',
            target: 1.30,
            status: 'LIVE_MICRO',
            holdout: { hitRate: 0.88, evPerBet: 0.14 }
        }
    ];

    const cfg = {
        ...config,
        POLLING_INTERVAL: 1000,
        LOG_LEVEL: 'error',
        MICRO_ONLY: false,
        RISK: {
            BASE_ENTRY_PROBABILITY: 0.50,
            BASE_CONFIDENCE_THRESHOLD: 0.50,
            WARMUP_ROUNDS: 0,
            PROMOTION_BETS: 1,
            PROMOTION_HIT_RATE: 0.50,
            DEMOTION_HIT_RATE: 0.20,
            DECISION_WINDOW: 10,
            VOLATILITY_LOOKBACK: 10,
            VOLATILITY_SPIKE_RATIO: 1.5,
            VOLATILITY_CONFIDENCE_PENALTY: 0.05
        },
        MODE: { PAPER: true }
    };
    const strategy = new BettingStrategy({
        strategy: 'MICRO',
        initialBet: 100,
        targetMultiplier: 1.30,
        minBet: 100,
        maxBet: 500
    });
    const predictor = new Predictor(cfg);
    for (let i = 0; i < 20; i++) predictor.addRound(1.50);
    predictor.addRound(1.15); // Trigger condition

    const patterns = new PatternDetector(cfg);
    const bankroll = new Bankroll({ initialBalance: 100000 });
    bankroll.setPaperReference(100000);

    const brain = new Brain({
        config: cfg,
        strategy,
        predictor,
        patterns,
        bankroll,
        signalLifecycle: life
    });

    brain.tier = 'MICRO';
    const decision = brain.decide({ bettingWindow: true, balance: 100000 });

    assert.ok(decision.shouldBet, 'Brain should approve bet when confirmed hypothesis signal is active');
    assert.ok(decision.activeHypothesisSignal, 'Decision should carry active hypothesis signal metadata');
    assert.strictEqual(decision.activeHypothesisSignal.id, 'prior_low_crash_target_1.3');

    cleanFile(life.getFilePath());
});
