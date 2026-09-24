'use strict';

/**
 * fair-audit.js — audit the CRASH DISTRIBUTION and the provably-fair evidence
 * (intelligence-ladder layer 4: the only hypothesis stream-analysis cannot
 * test).
 *
 * Round-prediction research asks "can we read the stream?". This asks the
 * different question "is the machine behind the stream doing what it
 * claims?". For a fair crash game with house edge r:
 *
 *     P(crash = 1.00x)          = r              (instant-bust mass)
 *     P(crash >= x), x > 1      = (1 - r) / x    (Pareto tail)
 *
 * So the audit:
 *   1. estimates r from the observed instant-bust mass;
 *   2. compares the empirical survival curve against (1 - r)/x at the
 *      thresholds the bot actually bets on (1.3, 1.5, 2, 3, 5, 10) with
 *      binomial significance tests;
 *   3. reads the provably-fair capture log (data/provablyfair-<site>.jsonl)
 *      for seed reuse / revealed-seed anomalies.
 *
 * CONSISTENT does not PROVE fairness — it means no measurable skew. FLAGGED
 * means the site's stream deviates from the fair curve in a way that costs
 * (or pays) the bot, and is actionable.
 *
 * Usage:
 *   node scripts/fair-audit.js [--site betpawa.ug]
 */

const fs = require('fs');
const path = require('path');
const config = require('../util/config');
const { loadRecordedHistory } = require('./walk-forward');
const { normCdf } = require('../game/modelLayer');
const { ProvablyFairLog, analyze } = require('../game/provablyFair');

const THRESHOLDS = [1.3, 1.5, 2, 3, 5, 10];
const INSTANT_MAX = 1.01; // rounding: 1.00x may display as 1 or 1.00

/** Two-sided binomial p-value via normal approximation. */
function binomialPValue(hits, n, p) {
    if (n <= 0 || !(p > 0 && p < 1)) return 1;
    const se = Math.sqrt((p * (1 - p)) / n);
    if (se === 0) return 1;
    const z = Math.abs(hits / n - p) / se;
    return Math.max(0, Math.min(1, 2 * (1 - normCdf(z))));
}

/**
 * Pure distribution audit over crash values. Returns structured findings;
 * no I/O. `values` must be crash multipliers (>= 1).
 */
function auditDistribution(values, opts = {}) {
    const thresholds = opts.thresholds || THRESHOLDS;
    const vals = values.filter((v) => Number.isFinite(v) && v >= 1);
    const n = vals.length;
    if (n < 100) return { n, verdict: 'INSUFFICIENT_DATA', reason: `only ${n} rounds (need 100+)` };

    // Instant-bust mass = the house edge under the fair model.
    const instant = vals.filter((v) => v <= INSTANT_MAX).length;
    const r = instant / n;

    const bins = [];
    let flagged = [];
    const watch = [];
    // Bonferroni: flagging at alpha/num_thresholds keeps the family-wise
    // false-flag rate at ~1% for a genuinely fair stream. Six thresholds
    // are tested on the SAME rounds, so a raw p=0.01 per threshold would
    // false-flag a fair game ~6% of the time.
    const flagP = 0.01 / thresholds.length;
    const nominalP = 0.01;
    for (const t of thresholds) {
        const survive = vals.filter((v) => v >= t).length;
        const expected = (1 - r) / t;
        const empirical = survive / n;
        const p = binomialPValue(survive, n, expected);
        const dev = empirical - expected;
        bins.push({
            threshold: t,
            empirical: Number(empirical.toFixed(4)),
            fair: Number(expected.toFixed(4)),
            deviation: Number(dev.toFixed(4)),
            pValue: Number(p.toFixed(4))
        });
        // Direction labels: fewer survivors than fair = the site crashes LOW
        // more often than a fair game (hurts every cashout strategy); more
        // survivors = crashes run HIGH (helps, and worth knowing too).
        const label = `${dev < 0 ? 'LOW-SKEW' : 'HIGH-SKEW'} at ${t}x: observed ${(empirical * 100).toFixed(1)}% survive vs fair ${(expected * 100).toFixed(1)}% (p=${p.toFixed(4)})`;
        if (p < flagP) {
            flagged.push(label); // survives Bonferroni — a real flag
        } else if (p < nominalP) {
            watch.push(`${label} — nominal only, does NOT survive multiple-testing correction`);
        }
    }

    // The instant-bust mass should equal r BY construction; but a fair game
    // with edge r also implies P(X>=x) <= (1)/x — check the mass estimate is
    // sane (1%..6% is the plausible operator band).
    const plausibleEdge = r >= 0.005 && r <= 0.08;
    if (!plausibleEdge) flagged.push(`instant-bust mass ${(r * 100).toFixed(2)}% outside the plausible operator band (0.5%-8%)`);

    const verdict = flagged.length === 0 ? 'CONSISTENT_WITH_FAIR' : 'FLAGGED';
    return {
        n,
        instantBustRate: Number(r.toFixed(4)),
        estimatedHouseEdge: Number(r.toFixed(4)),
        bins,
        flagged,
        watch,
        verdict,
        reason: flagged.length === 0
            ? `survival curve matches the fair-game tail within noise (edge estimate ${(r * 100).toFixed(2)}%)`
            : flagged.join('; ')
    };
}

function runSite(siteId) {
    const { values, source } = loadRecordedHistory(config.DATA_DIR, siteId);
    const dist = auditDistribution(values);

    // Provably-fair capture evidence (may not exist yet — capture needs the
    // in-game fairness panel to have been scanned at least once).
    const safe = String(siteId).replace(/[^a-z0-9.-]/gi, '-');
    const pfFile = path.join(config.DATA_DIR, `provablyfair-${safe}.jsonl`);
    let pf = null;
    if (fs.existsSync(pfFile)) {
        const records = new ProvablyFairLog(pfFile).readAll();
        const a = analyze(records);
        pf = {
            records: a.records,
            distinctHex64: a.distinctHex64,
            revealedServerSeeds: a.revealedServerSeeds.length,
            reusedValues: a.reusedValues.length,
            anomalies: a.anomalies
        };
    }

    return { site: siteId, source, rounds: dist.n, distribution: dist, provablyFair: pf };
}

function main() {
    const args = process.argv.slice(2);
    const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
    // Discover sites from history files directly.
    const names = fs.existsSync(config.DATA_DIR)
        ? fs.readdirSync(config.DATA_DIR).filter((f) => /^history-.+\.json$/.test(f))
            .map((f) => f.replace(/^history-/, '').replace(/\.json$/, ''))
            .filter((s) => !siteArg || s === siteArg)
        : [];
    if (names.length === 0) {
        console.log(siteArg ? `No recorded history for site "${siteArg}" in ${config.DATA_DIR}.`
            : `No recorded history in ${config.DATA_DIR} — run the bot first.`);
        process.exit(1);
    }
    console.log('=====================================================');
    console.log(' FAIRNESS AUDIT (crash distribution + fair evidence)');
    console.log('=====================================================');
    for (const site of names) {
        const r = runSite(site);
        console.log(`\n[${r.site}] — ${r.rounds} recorded rounds`);
        const d = r.distribution;
        if (d.verdict === 'INSUFFICIENT_DATA') { console.log(`  skipped: ${d.reason}`); continue; }
        console.log(`  instant-bust (1.00x) mass: ${(d.instantBustRate * 100).toFixed(2)}%  ->  estimated house edge ${(d.estimatedHouseEdge * 100).toFixed(2)}%`);
        console.log('  survival vs fair-game tail:');
        console.log('    threshold   observed    fair    deviation   p');
        for (const b of d.bins) {
            console.log(`    ${String(b.threshold).padEnd(11)} ${(b.empirical * 100).toFixed(1).padStart(7)}% ${(b.fair * 100).toFixed(1).padStart(7)}% ${b.deviation > 0 ? '+' : ''}${(b.deviation * 100).toFixed(1).padStart(6)}pp  ${b.pValue}`);
        }
        console.log(`  DISTRIBUTION VERDICT: ${d.verdict} — ${d.reason}`);
        if (d.watch && d.watch.length) {
            console.log('  on watch (nominal drift, NOT confirmed after multiple-testing correction):');
            for (const w of d.watch) console.log(`    · ${w}`);
        }
        if (r.provablyFair) {
            const pf = r.provablyFair;
            console.log(`  provably-fair capture: ${pf.records} records, ${pf.distinctHex64} distinct hashes, ${pf.revealedServerSeeds} revealed seeds, ${pf.reusedValues} reused values`);
            if (pf.anomalies.length) for (const a of pf.anomalies) console.log(`    ⚠ ${a}`);
        } else {
            console.log('  provably-fair capture: none yet — open the shield/"Provably Fair" panel in-game and scan from the dashboard to start collecting hash evidence');
        }
    }
    console.log('\nNote: CONSISTENT_WITH_FAIR means no measurable skew — it does not prove fairness.');
    console.log('FLAGGED means the stream deviates from the fair curve in a way worth acting on.');
}

if (require.main === module) main();

module.exports = { auditDistribution, runSite, binomialPValue };
