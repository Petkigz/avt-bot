const test = require('node:test');
const assert = require('node:assert');
const config = require('../util/config');
const BettingStrategy = require('../game/strategies');

test('ALL strategy presets are present and valid (not just MICRO)', () => {
    const expected = ['MICRO', 'CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'];
    for (const name of expected) {
        assert.ok(config.BETTING_STRATEGIES[name], `missing preset: ${name}`);
        const { ok, errors } = BettingStrategy.validate(config.BETTING_STRATEGIES[name]);
        assert.strictEqual(ok, true, `${name} failed validation: ${errors.join(', ')}`);
        assert.strictEqual(config.BETTING_STRATEGIES[name].name, name);
    }
});

test('presets are ordered from safest to riskiest', () => {
    const { MICRO, CONSERVATIVE, MODERATE, AGGRESSIVE } = config.BETTING_STRATEGIES;
    assert.ok(MICRO.initialBet < CONSERVATIVE.initialBet);
    assert.ok(CONSERVATIVE.initialBet < MODERATE.initialBet);
    assert.ok(MODERATE.initialBet < AGGRESSIVE.initialBet);
    assert.ok(MICRO.stopLoss <= CONSERVATIVE.stopLoss);
    assert.ok(CONSERVATIVE.stopLoss <= MODERATE.stopLoss);
    assert.ok(MODERATE.stopLoss <= AGGRESSIVE.stopLoss);
});

test('STRATEGY env override accepts any preset name', () => {
    // config.STRATEGY may be empty by default; verify lookup works for all names
    for (const name of ['MICRO', 'CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']) {
        const preset = config.BETTING_STRATEGIES[name.toUpperCase()];
        assert.ok(preset, `STRATEGY=${name} would not resolve`);
    }
});

test('paper mode and MICRO defaults are the safe factory settings', () => {
    assert.strictEqual(config.MODE.PAPER, true);
    assert.strictEqual(config.MICRO_ONLY, false); // available but opt-in
    assert.ok(config.RISK.MIN_ROUNDS_OBSERVE >= 50);
    assert.ok(config.RISK.MAX_STAKE_FRACTION <= 0.05);
});

test('dashboard binds to localhost by default (personal, no-auth UI)', () => {
    if (!process.env.DASHBOARD_HOST) {
        assert.strictEqual(config.DASHBOARD.HOST, '127.0.0.1');
    } else {
        assert.ok(typeof config.DASHBOARD.HOST === 'string' && config.DASHBOARD.HOST.length > 0);
    }
});
