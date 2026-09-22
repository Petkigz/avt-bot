/**
 * Paper-mode simulator — runs the bot's REAL decision stack (Brain, model,
 * patterns, bankroll, strategy) over thousands of rounds with zero money
 * involved and zero browser involved.
 *
 * Round sources:
 *   replay    — your recorded history (data/history.json), looped
 *   synthetic — theoretical Aviator distribution P(crash >= x) = 0.99/x
 *   mixed     — alternate between the two
 *
 * Outputs a CSV (data/simulations/) with a row per round and prints a summary.
 *
 * Usage:
 *   npm run simulate
 *   node sim/simulate.js --rounds 10000 --source mixed --strategy MICRO --bankroll 50000
 */
const fs = require('fs');
const path = require('path');

const config = require('../util/config');
const BettingStrategy = require('../game/strategies');
const Predictor = require('../game/predictor');
const PatternDetector = require('../game/patternDetector');
const Bankroll = require('../game/bankroll');
const Brain = require('../game/brain');
const StatsTracker = require('../game/statsTracker');
const HistoryStore = require('../game/historyStore');
const CsvLog = require('../util/csvLog');

function syntheticCrash() {
    // Theoretical Aviator: 1% instant-bust house edge, P(X >= x) = 0.99/x
    const u = Math.random();
    return Math.max(1, Math.floor((0.99 / u) * 100) / 100);
}

function buildRoundSource(source, rounds) {
    let replay = [];
    if (source === 'replay' || source === 'mixed') {
        const store = new HistoryStore(path.join(config.DATA_DIR, 'history.json'));
        store.load();
        replay = store.values;
    }
    if (source === 'replay' && replay.length === 0) {
        throw new Error('No recorded history yet — run the bot (paper mode) first, or use --source synthetic');
    }

    let i = 0;
    return () => {
        const useReplay = source === 'replay' || (source === 'mixed' && i % 2 === 0);
        i++;
        if (useReplay && replay.length > 0) {
            return replay[(i - 1) % replay.length];
        }
        return syntheticCrash();
    };
}

/**
 * Runs a full simulation. Returns {summary, csvFile}.
 * Components are created WITHOUT persistence files so a simulation can never
 * clobber the live-learned memory.
 */
function runSimulation(options = {}) {
    const requestedRounds = options.rounds ?? 5000;
    const rounds = requestedRounds;
    const source = options.source ?? 'mixed';
    const strategyName = options.strategy ?? 'MICRO';
    const startingBankroll = options.startingBankroll ?? 50000;
    const longRun = !!options.longRun; // true: ignore strategy session limits (measure long-term behavior)
    const outDir = options.outDir ?? path.join(config.DATA_DIR, 'simulations');

    const strategyConfig = config.BETTING_STRATEGIES[strategyName];
    if (!strategyConfig) {
        throw new Error(`Unknown strategy "${strategyName}". Options: ${Object.keys(config.BETTING_STRATEGIES).join(', ')}`);
    }

    const strategy = new BettingStrategy({ ...strategyConfig });
    const predictor = new Predictor({
        targetMultiplier: strategyConfig.targetMultiplier,
        minSampleSize: config.MODEL.MIN_SAMPLE_SIZE,
        minEntryProbability: config.MODEL.MIN_ENTRY_PROBABILITY,
        maxEntryProbability: config.MODEL.MAX_ENTRY_PROBABILITY,
        coldStreakLimit: config.MODEL.COLD_STREAK_LIMIT,
        coldRecoveryCount: config.MODEL.COLD_RECOVERY_COUNT
        // no file -> simulation never writes the live model
    });
    const patterns = config.PATTERN.ENABLED ? new PatternDetector({
        lengths: config.PATTERN.LENGTHS,
        minSupport: config.PATTERN.MIN_SUPPORT,
        bins: config.PATTERN.BINS,
        targetMultiplier: strategyConfig.targetMultiplier
        // no file
    }) : null;
    const bankroll = new Bankroll({
        sessionLossLimit: config.RISK.SESSION_LOSS_LIMIT,
        dailyLossLimit: config.RISK.DAILY_LOSS_LIMIT,
        maxStakeFraction: config.RISK.MAX_STAKE_FRACTION,
        microStakeFraction: config.RISK.MICRO_STAKE_FRACTION,
        minStake: strategyConfig.minBet
        // no file
    });
    const brain = new Brain({ config, strategy, predictor, patterns, bankroll });
    const stats = new StatsTracker();

    bankroll.setBalance(startingBankroll);
    let balance = startingBankroll;
    let peak = startingBankroll;
    let maxDrawdown = 0;
    const skipReasons = {};
    const tierChanges = [];
    let lastTier = brain.tier;
    let haltedAt = null;

    fs.mkdirSync(outDir, { recursive: true });
    const csvFile = path.join(outDir, `sim-${Date.now()}.csv`);
    const csv = new CsvLog(csvFile, [
        'round', 'crash', 'tier', 'decision', 'reason', 'stake',
        'outcome', 'pnl', 'balance', 'confidence', 'pattern'
    ]);

    const nextCrash = buildRoundSource(source, rounds);
    let roundsRan = 0;

    for (let r = 1; r <= rounds; r++) {
        if (brain.tier !== lastTier) {
            tierChanges.push({ round: r, from: lastTier, to: brain.tier });
            lastTier = brain.tier;
        }

        if (bankroll.halted) break; // hard money guard — simulation over
        const strategyHalted = !longRun && haltedAt === null &&
            strategy.shouldStopTrading(stats.getStats()) && stats.totalTrades > 0;
        if (strategyHalted) { haltedAt = r; break; } // session limits — session over

        const decision = brain.decide({
            bettingWindow: true,
            balance,
            cooldownRounds: 0,
            halted: false
        });

        let pending = null;
        if (decision.shouldBet) {
            pending = { stake: decision.stake, confidence: decision.confidence, pattern: decision.pattern };
        } else {
            const reason = decision.reasons[0] || 'n/a';
            const key = reason.split(' (')[0]; // normalize variable parts
            skipReasons[key] = (skipReasons[key] || 0) + 1;
        }

        const crash = nextCrash();
        brain.onRoundEnded(crash);

        let outcome = 'none';
        let pnl = 0;
        if (pending) {
            const won = crash >= strategyConfig.targetMultiplier;
            pnl = won
                ? Math.round(pending.stake * (strategyConfig.targetMultiplier - 1) * 100) / 100
                : -pending.stake;
            outcome = won ? 'win' : 'loss';
            const trade = {
                betAmount: pending.stake,
                multiplier: crash,
                profit: won ? pnl : 0,
                loss: won ? 0 : pnl,
                won,
                timestamp: Date.now()
            };
            stats.addTrade(trade);
            brain.recordOutcome(trade, { pattern: pending.pattern });
            balance += pnl;
            peak = Math.max(peak, balance);
            maxDrawdown = Math.max(maxDrawdown, peak - balance);
        }

        csv.write({
            round: r,
            crash,
            tier: brain.tier,
            decision: pending ? 'bet' : 'skip',
            reason: pending ? 'all gates passed' : (decision.reasons[0] || ''),
            stake: pending ? pending.stake : '',
            outcome,
            pnl,
            balance: Math.round(balance * 100) / 100,
            confidence: pending && pending.confidence !== null ? pending.confidence.toFixed(3) : '',
            pattern: pending && pending.pattern ? pending.pattern.pattern : ''
        });
        roundsRan = r;
    }

    const s = stats.getStats();
    const summary = {
        rounds: roundsRan,
        requestedRounds,
        source,
        strategy: strategyName,
        startingBankroll,
        finalBalance: Math.round(balance * 100) / 100,
        pnl: Math.round((balance - startingBankroll) * 100) / 100,
        maxDrawdown: Math.round(maxDrawdown * 100) / 100,
        bets: s.totalTrades,
        wins: s.winningTrades,
        losses: s.losingTrades,
        winRate: Math.round(s.winRate * 10) / 10,
        finalTier: brain.tier,
        endedBy: bankroll.halted ? `bankroll guard: ${bankroll.haltReason}`
            : haltedAt !== null ? 'strategy session limits (stop-loss / take-profit / loss streak)'
            : 'completed all rounds',
        tierChanges,
        skipReasons,
        bankrollGuard: bankroll.halted ? bankroll.haltReason : 'never tripped',
        csvFile
    };
    return { summary, csvFile };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        args[key] = argv[i + 1];
    }
    return args;
}

if (require.main === module) {
    const args = parseArgs(process.argv);
    try {
        const { summary } = runSimulation({
            rounds: parseInt(args.rounds || '5000', 10),
            source: args.source || 'mixed',
            strategy: (args.strategy || 'MICRO').toUpperCase(),
            startingBankroll: parseFloat(args.bankroll || '50000'),
            longRun: process.argv.includes('--long-run'),
            outDir: args.out
        });

        console.log('\n================= SIMULATION SUMMARY =================');
        console.log(`Rounds:            ${summary.rounds} (${summary.source})`);
        console.log(`Strategy:          ${summary.strategy}`);
        console.log(`Starting bankroll: ${summary.startingBankroll}`);
        console.log(`Final balance:     ${summary.finalBalance}`);
        console.log(`P/L:               ${summary.pnl >= 0 ? '+' : ''}${summary.pnl}`);
        console.log(`Max drawdown:      ${summary.maxDrawdown}`);
        console.log(`Bets placed:       ${summary.bets} (W ${summary.wins} / L ${summary.losses}, win rate ${summary.winRate}%)`);
        console.log(`Final tier:        ${summary.finalTier}`);
        console.log(`Tier changes:      ${summary.tierChanges.map((t) => `r${t.round}:${t.from}->${t.to}`).join(', ') || 'none'}`);
        console.log(`Bankroll guard:    ${summary.bankrollGuard}`);
        console.log('Skip reasons:');
        for (const [reason, count] of Object.entries(summary.skipReasons).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${count.toString().padStart(6)}  ${reason}`);
        }
        console.log(`\nRound-by-round CSV: ${summary.csvFile}`);
        console.log('=======================================================\n');
    } catch (error) {
        console.error(`Simulation failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { runSimulation, syntheticCrash };
