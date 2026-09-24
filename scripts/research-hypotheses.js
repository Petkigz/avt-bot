'use strict';

/**
 * scripts/research-hypotheses.js
 *
 * Runs the Automated Hypothesis Discovery & OOS Validation Engine.
 * Tests hundreds of conditional hypotheses across sequences, streaks, and
 * volatility, and surfaces any candidate that survives 3-tier holdouts.
 *
 * Usage:
 *   npm run research:hypotheses
 *   node scripts/research-hypotheses.js --site betpawa.ug
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { runHypothesisEngine } = require('../research/hypothesisEngine');

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
    console.log(' AUTOMATED HYPOTHESIS DISCOVERY & 3-TIER OOS VALIDATION ENGINE');
    console.log('===============================================================');

    for (const target of targets) {
        const fullPath = path.join(config.DATA_DIR, target.file);
        try {
            const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            const values = Array.isArray(raw) ? raw : (raw.values || []);
            console.log(`\n---------------------------------------------------------------`);
            console.log(` SITE: ${target.siteId} (${values.length} recorded rounds)`);
            console.log(`---------------------------------------------------------------`);

            const res = runHypothesisEngine(values);
            if (res.error) {
                console.log(`  [SKIPPED] ${res.error}`);
                continue;
            }

            console.log(`  Total Hypotheses Formulated & Tested: ${res.totalTested}`);
            console.log(`  ├─ Tier 1 (In-Sample Discovery):     ${res.tier1Discovered} passed discovery`);
            console.log(`  ├─ Tier 2 (OOS Walk Validation):     ${res.tier2OosConfirmed} passed out-of-sample`);
            console.log(`  └─ Tier 3 (Locked Final Holdout):    ${res.tier3HoldoutConfirmed} CONFIRMED`);

            if (res.allDiscoveryCandidates.length > 0) {
                console.log(`\n  Tier 1 In-Sample Discoveries (FDR Screened):`);
                res.allDiscoveryCandidates.slice(0, 8).forEach((c) => {
                    console.log(`   * [${c.id}] hit ${(c.hitRate * 100).toFixed(1)}% (lift +${(c.lift * 100).toFixed(1)}%, N=${c.n}, p=${c.pVal}, adjP=${c.adjPVal})`);
                });
                if (res.allDiscoveryCandidates.length > 8) {
                    console.log(`     ... and ${res.allDiscoveryCandidates.length - 8} more`);
                }
            }

            if (res.oosEvaluations.length > 0) {
                console.log(`\n  Tier 2 OOS Walk-Forward Filter Results:`);
                res.oosEvaluations.forEach((c) => {
                    console.log(`   * [${c.id}] ${c.status} -> Discovery Lift: +${(c.discoveryLift * 100).toFixed(1)}%, OOS Lift: ${c.oosLift !== null ? `${(c.oosLift * 100).toFixed(1)}%` : 'n/a'}, OOS EV: ${c.oosEv !== null ? c.oosEv : 'n/a'}`);
                });
            }

            if (res.finalRegistry.length > 0) {
                console.log(`\n  Tier 3 Final Holdout Status:`);
                res.finalRegistry.forEach((c) => {
                    console.log(`   * [${c.name}] => ${c.status} (Holdout Lift: ${c.holdout ? `${(c.holdout.lift * 100).toFixed(1)}%` : 'n/a'}, EV: ${c.holdout ? c.holdout.evPerBet : 'n/a'})`);
                });

                // Persist Candidate Registry
                const regFile = path.join(config.DATA_DIR, `hypothesis-candidates-${String(target.siteId).replace(/[^a-z0-9._-]/gi, '_')}.json`);
                fs.writeFileSync(regFile, JSON.stringify(res.finalRegistry, null, 2));
                console.log(`  Saved candidate registry to ${path.basename(regFile)}`);
            }

            console.log(`\n  =============================================================`);
            console.log(`  VERDICT: ${res.verdict}`);
            console.log(`  ${res.summary}`);
            console.log(`  =============================================================`);
        } catch (err) {
            console.log(`  Error running hypothesis engine: ${err.message}`);
        }
    }
}

if (require.main === module) run();

module.exports = { run };
