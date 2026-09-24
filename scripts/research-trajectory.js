'use strict';

/**
 * scripts/research-trajectory.js
 *
 * Runs the Microstructure & Trajectory Laboratory on recorded flight traces.
 *
 * Usage:
 *   npm run research:trajectory
 *   node scripts/research-trajectory.js --site betpawa.ug
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { analyzeTrajectories } = require('../research/trajectoryLab');

function getSiteTraceFiles() {
    if (!fs.existsSync(config.DATA_DIR)) return [];
    return fs.readdirSync(config.DATA_DIR)
        .filter((f) => /^traces-.*\.jsonl$/.test(f))
        .map((f) => ({
            file: f,
            siteId: f.replace(/^traces-/, '').replace(/\.jsonl$/, '')
        }));
}

function run() {
    const args = process.argv.slice(2);
    const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;

    let targets = getSiteTraceFiles();
    if (siteArg) targets = targets.filter((t) => t.siteId === siteArg);

    if (targets.length === 0) {
        console.log(siteArg
            ? `No trajectory trace file found for site "${siteArg}" in ${config.DATA_DIR}.`
            : `No trajectory trace files found in ${config.DATA_DIR} — run the bot in paper/live mode to record traces.`);
        process.exit(0);
    }

    console.log('===============================================================');
    console.log(' MICROSTRUCTURE & FLIGHT TRAJECTORY LABORATORY');
    console.log('===============================================================');

    for (const target of targets) {
        const fullPath = path.join(config.DATA_DIR, target.file);
        try {
            const lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter(Boolean);
            const traces = [];
            for (const line of lines) {
                try { traces.push(JSON.parse(line)); } catch (e) { /* skip */ }
            }
            console.log(`\n---------------------------------------------------------------`);
            console.log(` SITE: ${target.siteId} (${traces.length} recorded flight traces)`);
            console.log(`---------------------------------------------------------------`);

            const res = analyzeTrajectories(traces);
            if (res.error) {
                console.log(`  [SKIPPED] ${res.error}`);
                continue;
            }

            console.log(`\n  1. Trajectory Timing & Velocity:`);
            console.log(`     Traces with duration: ${res.tracesWithDuration}`);
            console.log(`     Avg Multiplier Velocity: ${res.avgVelocityPerSec !== null ? `${res.avgVelocityPerSec}x / sec` : 'n/a'}`);

            if (res.timeTo12Analysis) {
                console.log(`\n  2. Early Growth Speed vs 2.0x Survival (Time-to-1.2x):`);
                console.log(`     Median Time to 1.2x:   ${res.timeTo12Analysis.medianTimeTo12Ms} ms`);
                console.log(`     Hit-rate when fast:    ${(res.timeTo12Analysis.hitRate20WhenFast * 100).toFixed(1)}% (N=${res.timeTo12Analysis.sampleFast})`);
                console.log(`     Hit-rate when slow:    ${(res.timeTo12Analysis.hitRate20WhenSlow * 100).toFixed(1)}% (N=${res.timeTo12Analysis.sampleSlow})`);
                console.log(`     Difference:            ${(res.timeTo12Analysis.rateDifference * 100).toFixed(1)}% -> ${res.timeTo12Analysis.significant ? 'CANDIDATE DISCOVERED' : 'No significant difference'}`);
            }

            if (res.interRoundIntervalAnalysis) {
                console.log(`\n  3. Inter-round Interval Timing vs 1.30x Survival:`);
                console.log(`     Median Inter-round Gap: ${res.interRoundIntervalAnalysis.medianIntervalMs} ms`);
                console.log(`     Quick rounds 1.3x hit: ${(res.interRoundIntervalAnalysis.hitRate13Quick * 100).toFixed(1)}% (N=${res.interRoundIntervalAnalysis.quickRoundsCount})`);
                console.log(`     Delayed rounds 1.3x hit:${(res.interRoundIntervalAnalysis.hitRate13Delayed * 100).toFixed(1)}% (N=${res.interRoundIntervalAnalysis.delayedRoundsCount})`);
            }

            console.log(`\n  =============================================================`);
            console.log(`  VERDICT: ${res.verdict}`);
            console.log(`  ${res.summary}`);
            console.log(`  =============================================================`);
        } catch (err) {
            console.log(`  Error reading trace file: ${err.message}`);
        }
    }
}

if (require.main === module) run();

module.exports = { run };
