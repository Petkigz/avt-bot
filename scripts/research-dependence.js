'use strict';

/**
 * scripts/research-dependence.js
 *
 * Runs the non-ML Dependence Laboratory against recorded round histories
 * for every site (or a specified site via --site <id>).
 *
 * Usage:
 *   npm run research:dependence
 *   node scripts/research-dependence.js --site betpawa.ug
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { analyzeDependence } = require('../research/dependenceLab');

function getSiteFiles() {
    if (!fs.existsSync(config.DATA_DIR)) return [];
    return fs.readdirSync(config.DATA_DIR)
        .filter((f) => /^history-.*\.json$/.test(f))
        .map((f) => ({
            file: f,
            siteId: f.replace(/^history-/, '').replace(/\.json$/, '')
        }));
}

function run() {
    const args = process.argv.slice(2);
    const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;

    let targets = getSiteFiles();
    if (siteArg) targets = targets.filter((t) => t.siteId === siteArg);

    if (targets.length === 0) {
        console.log(siteArg
            ? `No recorded history found for site "${siteArg}" in ${config.DATA_DIR}.`
            : `No recorded history files found in ${config.DATA_DIR} — run the bot to collect rounds.`);
        process.exit(0);
    }

    console.log('===============================================================');
    console.log(' DEPENDENCE & MICROSTRUCTURE LABORATORY (Non-ML Hypothesis Testing)');
    console.log('===============================================================');

    for (const target of targets) {
        const fullPath = path.join(config.DATA_DIR, target.file);
        try {
            const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            const values = Array.isArray(raw) ? raw : (raw.values || []);
            console.log(`\n---------------------------------------------------------------`);
            console.log(` SITE: ${target.siteId} (${values.length} recorded rounds)`);
            console.log(`---------------------------------------------------------------`);

            const res = analyzeDependence(values);
            if (res.error) {
                console.log(`  [SKIPPED] ${res.error}`);
                continue;
            }

            console.log(`\n  1. PIT (Probability Integral Transform) & Ljung-Box Serial Test:`);
            console.log(`     PIT Autocorr (lags 1-5): [${res.pit.autocorr.join(', ')}]`);
            console.log(`     Ljung-Box Q: ${res.pit.ljungBox.q} (df=${res.pit.ljungBox.df}, p=${res.pit.ljungBox.pValue}) -> ${res.pit.ljungBox.significant ? 'REJECTS independence (flagged)' : 'Consistent with independence (p > 0.05)'}`);

            console.log(`\n  2. Multi-representation Autocorrelations (lag 1):`);
            console.log(`     Raw Multiplier:       ${res.autocorrelation.raw[0] || 'n/a'}`);
            console.log(`     Log Multiplier:       ${res.autocorrelation.log[0] || 'n/a'}`);
            console.log(`     1(Crash >= 1.30x):    ${res.autocorrelation.indicator13[0] || 'n/a'}`);
            console.log(`     1(Crash >= 2.00x):    ${res.autocorrelation.indicator20[0] || 'n/a'}`);

            if (res.markov3) {
                console.log(`\n  3. Markov State Transition Matrix (Tercile bins):`);
                console.log(`     Thresholds: <${res.markov3.thresholds[0]}x, ${res.markov3.thresholds[0]}..${res.markov3.thresholds[1]}x, >${res.markov3.thresholds[1]}x`);
                res.markov3.transitionMatrix.forEach((row, idx) => {
                    const label = idx === 0 ? 'From Low:   ' : idx === 1 ? 'From Med:   ' : 'From High:  ';
                    console.log(`     ${label} [${row.map((p) => p.toFixed(2)).join(', ')}]`);
                });
                console.log(`     Independence Chi2: ${res.markov3.chi2} (df=${res.markov3.df}, p=${res.markov3.pValue}) -> ${res.markov3.independent ? 'Independent (no Markov memory)' : 'NON-INDEPENDENT (Markov shift)'}`);
            }

            if (res.mutualInformation) {
                console.log(`\n  4. Shannon Mutual Information & Conditional Entropy:`);
                console.log(`     Entropy H(X):          ${res.mutualInformation.entropyBits} bits`);
                console.log(`     Mutual Info I(X_t;X_t+1): ${res.mutualInformation.mutualInfoBits} bits (Expected null: ${res.mutualInformation.expectedNullMIBits} bits)`);
                console.log(`     Permutation test p:    ${res.mutualInformation.permutationPValue} -> ${res.mutualInformation.significant ? 'SIGNIFICANT information transfer' : 'No excess information over noise'}`);
            }

            if (res.runsTest) {
                console.log(`\n  5. Wald-Wolfowitz Runs Test:`);
                console.log(`     Observed Runs: ${res.runsTest.observedRuns} vs Expected: ${res.runsTest.expectedRuns} (median ${res.runsTest.median}x)`);
                console.log(`     Z-score: ${res.runsTest.zScore} (p=${res.runsTest.pValue}) -> ${res.runsTest.random ? 'Random clustering' : 'Non-random clustering'}`);
            }

            console.log(`\n  =============================================================`);
            console.log(`  VERDICT: ${res.verdict}`);
            console.log(`  ${res.summary}`);
            console.log(`  =============================================================`);
        } catch (err) {
            console.log(`  Error reading history file: ${err.message}`);
        }
    }
}

if (require.main === module) run();

module.exports = { run };
