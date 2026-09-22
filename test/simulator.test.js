const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSimulation, syntheticCrash } = require('../sim/simulate');

test('synthetic crashes respect the Aviator distribution bounds', () => {
    for (let i = 0; i < 1000; i++) {
        const v = syntheticCrash();
        assert.ok(Number.isFinite(v) && v >= 1);
    }
});

test('simulation runs thousands of rounds and writes a CSV', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-'));
    const { summary, csvFile } = runSimulation({
        rounds: 1500,
        source: 'synthetic',
        strategy: 'MICRO',
        startingBankroll: 50000,
        outDir
    });

    assert.ok(summary.rounds > 0 && summary.rounds <= 1500);
    assert.ok(Number.isFinite(summary.finalBalance));
    assert.ok(Number.isFinite(summary.pnl));
    assert.ok(Number.isFinite(summary.maxDrawdown));
    assert.ok(summary.maxDrawdown >= 0);
    assert.ok(['OBSERVING', 'MICRO', 'ARMED'].includes(summary.finalTier));
    assert.ok(summary.bets >= 0);
    assert.ok(summary.bets <= summary.rounds);
    if (summary.bets > 0) {
        assert.strictEqual(summary.wins + summary.losses, summary.bets);
    }
    assert.ok(fs.existsSync(csvFile));
    const rows = fs.readFileSync(csvFile, 'utf8').trim().split('\n');
    assert.strictEqual(rows.length, summary.rounds + 1); // header + one row per round
    fs.rmSync(outDir, { recursive: true, force: true });
});

test('simulation never bets during warm-up (first rounds are all skips)', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-'));
    const { csvFile } = runSimulation({
        rounds: 300,
        source: 'synthetic',
        strategy: 'MICRO',
        startingBankroll: 50000,
        outDir
    });
    const rows = fs.readFileSync(csvFile, 'utf8').trim().split('\n').slice(1);
    // The first MIN_ROUNDS_OBSERVE rounds must all be skips (warm-up is mandatory)
    const warmupRows = rows.slice(0, 50);
    for (const row of warmupRows) {
        assert.ok(row.includes('skip'), `expected skip during warm-up, got: ${row}`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
});

test('bankroll guard trips in a simulated worst case', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-'));
    // Tiny bankroll + aggressive strategy: limits should engage or stakes stay tiny
    const { summary } = runSimulation({
        rounds: 800,
        source: 'synthetic',
        strategy: 'AGGRESSIVE',
        startingBankroll: 5000,
        outDir
    });
    assert.ok(Number.isFinite(summary.finalBalance));
    assert.ok(summary.finalBalance > -1, 'bankroll guard must prevent deep negative balances');
    fs.rmSync(outDir, { recursive: true, force: true });
});

test('unknown strategy is rejected', () => {
    assert.throws(() => runSimulation({ rounds: 10, strategy: 'NOPE', outDir: os.tmpdir() }), /Unknown strategy/);
});

test('batch mode aggregates multiple runs for large-sample analysis', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
    const { summary, runs } = require('../sim/simulate').runBatch({
        batch: 3,
        rounds: 400,
        source: 'synthetic',
        strategy: 'MICRO',
        startingBankroll: 50000,
        outDir
    });

    assert.strictEqual(summary.batchRuns, 3);
    assert.strictEqual(runs.length, 3);
    assert.ok(Number.isFinite(summary.avgPnl));
    assert.ok(Number.isFinite(summary.medianPnl));
    assert.ok(summary.worstPnl <= summary.medianPnl);
    assert.ok(summary.medianPnl <= summary.bestPnl);
    assert.ok(summary.profitableRuns >= 0 && summary.profitableRuns <= 3);
    assert.ok(summary.bankrollGuardTrips >= 0 && summary.bankrollGuardTrips <= 3);
    assert.ok(fs.existsSync(summary.aggregateCsv));
    const rows = fs.readFileSync(summary.aggregateCsv, 'utf8').trim().split('\n');
    assert.strictEqual(rows.length, 4); // header + 3 runs
    fs.rmSync(outDir, { recursive: true, force: true });
});
