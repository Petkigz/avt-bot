'use strict';

/**
 * scripts/research-distribution.js
 *
 * Runs the Distributional Research Laboratory against recorded round
 * histories to analyze the entire survival curve and test for conditional
 * distribution shifts.
 *
 * Usage:
 *   npm run research:distribution
 *   node scripts/research-distribution.js --site betpawa.ug
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { analyzeDistribution, TARGET_GRID } = require('../research/distributionLab');

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
    console.log(' DISTRIBUTIONAL RESEARCH LABORATORY (Full Survival Curve Analysis)');
    console.log('===============================================================');

    for (const target of targets) {
        const fullPath = path.join(config.DATA_DIR, target.file);
        try {
            const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            const values = Array.isArray(raw) ? raw : (raw.values || []);
            console.log(`\n---------------------------------------------------------------`);
            console.log(` SITE: ${target.siteId} (${values.length} recorded rounds)`);
            console.log(`---------------------------------------------------------------`);

            const res = analyzeDistribution(values);
            if (res.error) {
                console.log(`  [SKIPPED] ${res.error}`);
                continue;
            }

            console.log(`\n  1. Empirical vs Theoretical Survival Curve S(x) = P(X >= x):`);
            console.log(`     Target:   ` + TARGET_GRID.map((t) => String(t).padStart(6)).join(' '));
            console.log(`     Empirical:` + TARGET_GRID.map((t) => (res.unconditionalSurvival[t] !== undefined ? (res.unconditionalSurvival[t] * 100).toFixed(1) + '%' : '  n/a').padStart(6)).join(' '));
            console.log(`     Null:     ` + TARGET_GRID.map((t) => (res.theoreticalNull[t] !== undefined ? (res.theoreticalNull[t] * 100).toFixed(1) + '%' : '  n/a').padStart(6)).join(' '));
            console.log(`     Estimated Instant-Crash Operator Edge: ${(res.operatorEdge * 100).toFixed(2)}%`);

            console.log(`\n  2. Conditional Survival Curves:`);
            console.log(`     After <1.30x: ` + [1.2, 1.3, 1.5, 2.0, 3.0, 5.0].map((t) => `${t}x:${(res.conditionalSurvivals.afterLow[t] * 100).toFixed(1)}%`).join(' '));
            console.log(`     After >=2.0x: ` + [1.2, 1.3, 1.5, 2.0, 3.0, 5.0].map((t) => `${t}x:${(res.conditionalSurvivals.afterHigh[t] * 100).toFixed(1)}%`).join(' '));

            console.log(`\n  3. Two-Sample Kolmogorov-Smirnov & Wasserstein Distance Tests:`);
            console.log(`     After Low (<1.3x) vs After High (>=2.0x):`);
            console.log(`       KS Statistic D:      ${res.tests.afterLowVsHigh.d} (Sample sizes: ${res.tests.afterLowVsHigh.sampleSizeA} vs ${res.tests.afterLowVsHigh.sampleSizeB})`);
            console.log(`       Permutation p-value: ${res.tests.afterLowVsHigh.pValue} -> ${res.tests.afterLowVsHigh.significant ? 'SIGNIFICANT SHIFT' : 'No significant shift (p > 0.05)'}`);
            console.log(`       Wasserstein Distance: ${res.tests.afterLowVsHigh.wassersteinDistance}`);

            console.log(`     After 3-Cold Streak vs After 2-Warm Streak:`);
            console.log(`       KS Statistic D:      ${res.tests.afterColdVsWarmStreak.d} (p=${res.tests.afterColdVsWarmStreak.pValue}) -> ${res.tests.afterColdVsWarmStreak.significant ? 'SIGNIFICANT SHIFT' : 'No significant shift (p > 0.05)'}`);

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
