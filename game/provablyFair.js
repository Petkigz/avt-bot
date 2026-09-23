'use strict';

/**
 * provablyFair.js — capture & analysis of the game's provably-fair data.
 *
 * Spribe's scheme (publicly documented):
 *   roundHash = SHA256(serverSeed + ":" + clientSeed + ":" + nonce)
 * The server seed is hash-committed BEFORE the round and revealed only when
 * the seed pair rotates. If an implementation were weak (seed reuse, leaked
 * plaintext seeds, nonce tricks) the evidence would live in THIS data — not
 * in the crash values themselves. That is what this layer hunts for:
 *
 *   1. collectInFrame()   — runs inside the page, finds fair-panel content
 *   2. parseCapturedTexts — turns raw text into structured fields
 *   3. ProvablyFairLog    — persistent JSONL record per site
 *   4. analyze()          — seed reuse / duplicate detection
 *   5. deriveCrash*       — candidate formulas; on revealed seeds we verify
 *                           which formula reproduces observed crashes, then
 *                           replay entire past rounds of that seed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Runs INSIDE the browser frame (serialized by puppeteer) — must be
 * self-contained. Collects anything that looks like provably-fair data:
 * long hex strings, fair/seed/nonce labels, and fair-panel buttons.
 */
function collectInFrame() {
    const hexRe = /[0-9a-f]{16,128}/i;
    const labelRe = /provably|fairness|server\s*seed|client\s*seed|nonce|round\s*hash/i;
    const texts = [];
    const scanRoot = (root) => {
        let walker;
        try {
            walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        } catch (error) { return; }
        let node;
        let guard = 0;
        while ((node = walker.nextNode()) && guard < 8000) {
            const text = (node.textContent || '').trim();
            if (!text || text.length > 600) continue;
            if (hexRe.test(text) || labelRe.test(text)) {
                const parent = node.parentElement;
                texts.push({
                    text: text.slice(0, 400),
                    cls: parent ? String(parent.className || '').slice(0, 100) : ''
                });
                guard += 1;
            }
        }
    };
    scanRoot(document.body);
    try {
        for (const sh of (document.querySelectorAll('div,section') || [])) {
            if (sh.shadowRoot) scanRoot(sh.shadowRoot);
        }
    } catch (error) { /* shadow roots optional */ }
    const buttons = [];
    try {
        const all = document.querySelectorAll('button, [role=button], a, [class*=fair], [class*=shield], [class*=provably]');
        for (const b of all) {
            const marker = `${b.className || ''} ${b.id || ''} ${b.textContent || ''}`;
            if (/fair|shield|provably/i.test(marker)) {
                buttons.push({
                    tag: b.tagName,
                    cls: String(b.className || '').slice(0, 120),
                    text: (b.textContent || '').trim().slice(0, 80)
                });
                if (buttons.length >= 20) break;
            }
        }
    } catch (error) { /* frame shutting down */ }
    return { url: location.href, texts: texts.slice(0, 80), buttons };
}

const HEX64 = /[0-9a-f]{64}/gi;

/** Heuristic parse of collected text snippets into structured fair data. */
function parseCapturedTexts(items) {
    const out = {
        hex64: [],            // all 64-hex strings seen (seeds or hashes)
        serverSeed: null,     // plaintext seed, if ever displayed
        serverSeedHash: null, // committed hash of the current seed
        clientSeed: null,
        nonce: null,
        labels: [],           // fair-related labels found (panel discovery proof)
        raw: []
    };
    if (!Array.isArray(items)) return out;
    for (const item of items) {
        const text = String(item.text || '');
        const lower = text.toLowerCase();
        const hexes = text.match(HEX64);
        if (/server\s*seed|client\s*seed|nonce|provably|fairness|round\s*hash/i.test(text)) {
            out.labels.push(text.slice(0, 160));
        }
        if (hexes) {
            for (const h of hexes) {
                const v = h.toLowerCase();
                if (!out.hex64.includes(v)) out.hex64.push(v);
                if (/server\s*seed\s*hash|hash/i.test(lower) && !out.serverSeedHash) out.serverSeedHash = v;
                else if (/server\s*seed/i.test(lower) && !out.serverSeed) out.serverSeed = v;
            }
        }
        const nonceMatch = /nonce[:\s]+(\d{1,12})/i.exec(text);
        if (nonceMatch && out.nonce === null) out.nonce = parseInt(nonceMatch[1], 10);
        const clientMatch = /client\s*seed[:\s]+([^\s]{1,120})/i.exec(text);
        if (clientMatch && !out.clientSeed) out.clientSeed = clientMatch[1];
        out.raw.push(text.slice(0, 300));
    }
    // If only one hex64 was labeled generically, treat it as the committed hash.
    if (!out.serverSeedHash && !out.serverSeed && out.hex64.length === 1) {
        out.serverSeedHash = out.hex64[0];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
class ProvablyFairLog {
    constructor(file) {
        this.file = file;
    }

    record(entry) {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.appendFileSync(this.file, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
            return true;
        } catch (error) {
            return false;
        }
    }

    readAll() {
        try {
            if (!fs.existsSync(this.file)) return [];
            return fs.readFileSync(this.file, 'utf8').split('\n')
                .map((line) => {
                    try { return JSON.parse(line.trim()); } catch (error) { return null; }
                })
                .filter((r) => r && typeof r === 'object');
        } catch (error) {
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
/** Hunt for implementation weakness across all captured records. */
function analyze(records) {
    const seen = {};
    let nonceMin = null;
    let nonceMax = null;
    for (const r of records) {
        for (const h of (r.hex64 || [])) seen[h] = (seen[h] || 0) + 1;
        if (r.serverSeed) seen[`seed:${r.serverSeed}`] = (seen[`seed:${r.serverSeed}`] || 0) + 1;
        if (Number.isFinite(r.nonce)) {
            nonceMin = nonceMin === null ? r.nonce : Math.min(nonceMin, r.nonce);
            nonceMax = nonceMax === null ? r.nonce : Math.max(nonceMax, r.nonce);
        }
    }
    const reused = Object.entries(seen)
        .filter(([key, count]) => count > 1)
        .map(([value, count]) => ({ value, count }));
    const revealedSeeds = records.filter((r) => r.serverSeed).map((r) => r.serverSeed);
    return {
        records: records.length,
        distinctHex64: Object.keys(seen).filter((k) => !k.startsWith('seed:')).length,
        revealedServerSeeds: [...new Set(revealedSeeds)],
        reusedValues: reused,
        nonceRange: nonceMin === null ? null : { min: nonceMin, max: nonceMax },
        anomalies: [
            ...(reused.length > 0 ? ['REUSED SEED/HASH VALUES DETECTED — investigate immediately'] : []),
            ...(revealedSeeds.length > 0 ? ['plaintext server seed captured — past rounds of that seed are now fully replayable'] : [])
        ]
    };
}

// ---------------------------------------------------------------------------
// Round derivation (candidate formulas, verified against observed crashes)
// ---------------------------------------------------------------------------
const TWO32 = 2 ** 32;

/** Candidate 1 — widely documented Spribe formula (uniform-inverse). */
function deriveCrashA(hashHex) {
    const h = parseInt(hashHex.slice(0, 8), 16);
    if (!Number.isFinite(h)) return null;
    if (h % 33 === 0) return 1.0; // instant-bust residue class
    const crash = Math.floor((100 * (TWO32 - h)) / (TWO32 - h - 1)) / 100;
    return Math.max(1, crash);
}

/** Candidate 2 — plain inverse-ratio (bustabit family, no residue rule). */
function deriveCrashB(hashHex) {
    const h = parseInt(hashHex.slice(0, 8), 16);
    if (!Number.isFinite(h)) return null;
    return Math.max(1, Math.floor(100 / (1 - h / TWO32)) / 100);
}

/** Candidate 3 — 5-byte variant some deployments use. */
function deriveCrashC(hashHex) {
    const h = parseInt(hashHex.slice(0, 10), 16);
    if (!Number.isFinite(h)) return null;
    const space = 2 ** 40;
    return Math.max(1, Math.floor(100 / (1 - h / space)) / 100);
}

const CANDIDATES = [
    { name: 'spribe-uniform-inverse', fn: deriveCrashA },
    { name: 'bustabit-inverse-ratio', fn: deriveCrashB },
    { name: 'five-byte-variant', fn: deriveCrashC }
];

function roundHash(serverSeed, clientSeed, nonce) {
    return crypto.createHash('sha256').update(`${serverSeed}:${clientSeed}:${nonce}`).digest('hex');
}

/**
 * Given a REVEALED server seed + the client seed and nonce of a round,
 * recompute the round hash and crash under every candidate formula. A
 * candidate matching the observed crash confirms the scheme; replaying all
 * nonces of that seed then reproduces entire history — which is exactly the
 * scenario "deterministic sequence" would predict, and what this tool tests.
 */
function replayRound(serverSeed, clientSeed, nonce, observedCrash = null) {
    const hash = roundHash(serverSeed, clientSeed, nonce);
    const derived = CANDIDATES.map(({ name, fn }) => ({ name, crash: fn(hash) }));
    let match = null;
    if (observedCrash !== null) {
        for (const d of derived) {
            if (Math.abs(d.crash - observedCrash) < 0.005) { match = d.name; break; }
        }
    }
    return { hash, derived, match };
}

module.exports = {
    collectInFrame,
    parseCapturedTexts,
    ProvablyFairLog,
    analyze,
    roundHash,
    replayRound,
    CANDIDATES
};
