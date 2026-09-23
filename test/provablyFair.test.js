'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    parseCapturedTexts,
    ProvablyFairLog,
    analyze,
    roundHash,
    replayRound,
    CANDIDATES
} = require('../game/provablyFair');

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b1c2d3e4'.repeat(8);

test('parseCapturedTexts classifies seeds, hashes, nonces and client seeds', () => {
    const parsed = parseCapturedTexts([
        { text: `Server Seed Hash: ${HEX_A}` },
        { text: `Server Seed: ${HEX_B}` },
        { text: 'Client Seed: 5f3a9c,2b7d1e,91c4aa' },
        { text: 'Nonce: 81234' }
    ]);
    assert.equal(parsed.serverSeedHash, HEX_A);
    assert.equal(parsed.serverSeed, HEX_B);
    assert.equal(parsed.clientSeed, '5f3a9c,2b7d1e,91c4aa');
    assert.equal(parsed.nonce, 81234);
    assert.ok(parsed.labels.length >= 2);
    assert.equal(parsed.hex64.length, 2);
});

test('a single unlabeled hex value is treated as the committed hash', () => {
    const parsed = parseCapturedTexts([{ text: `hash is ${HEX_A} ok` }]);
    assert.equal(parsed.serverSeedHash, HEX_A);
    assert.equal(parsed.serverSeed, null);
});

test('analyze flags reused values and revealed seeds', () => {
    const records = [
        { hex64: [HEX_A], nonce: 10 },
        { hex64: [HEX_A], nonce: 20 },         // same value twice
        { hex64: [HEX_B], serverSeed: HEX_B, nonce: 30 }
    ];
    const a = analyze(records);
    assert.equal(a.records, 3);
    assert.equal(a.distinctHex64, 2);
    assert.ok(a.reusedValues.some((r) => r.value === HEX_A && r.count === 2));
    assert.deepEqual(a.revealedServerSeeds, [HEX_B]);
    assert.deepEqual(a.nonceRange, { min: 10, max: 30 });
    assert.ok(a.anomalies.some((m) => /REUSED/.test(m)));
    assert.ok(a.anomalies.some((m) => /plaintext server seed/.test(m)));
});

test('analyze on clean data reports no anomalies', () => {
    const a = analyze([{ hex64: [HEX_A], nonce: 1 }, { hex64: [HEX_B], nonce: 2 }]);
    assert.equal(a.anomalies.length, 0);
});

test('round hash is deterministic SHA256(serverSeed:clientSeed:nonce)', () => {
    const h1 = roundHash('seed1', 'client1', 42);
    const h2 = roundHash('seed1', 'client1', 42);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
    assert.notEqual(h1, roundHash('seed1', 'client1', 43));
});

test('replayRound confirms the derivation formula against an observed crash', () => {
    // Simulate a REVEALED seed: derive the "observed" crash with candidate A
    // itself, then verify replayRound identifies the matching formula.
    const serverSeed = 'deadbeef'.repeat(8);
    const clientSeed = 'abc,def,123';
    const nonce = 777;
    const hash = roundHash(serverSeed, clientSeed, nonce);
    const observed = CANDIDATES[0].fn(hash); // candidate A produced this round
    const replay = replayRound(serverSeed, clientSeed, nonce, observed);
    assert.equal(replay.hash, hash);
    assert.equal(replay.match, CANDIDATES[0].name);
    // every candidate still produces a valid crash value
    for (const d of replay.derived) {
        assert.ok(Number.isFinite(d.crash) && d.crash >= 1, `${d.name} gave ${d.crash}`);
    }
});

test('ProvablyFairLog persists records and skips corrupt lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-pf-'));
    const file = path.join(dir, 'pf.jsonl');
    const log = new ProvablyFairLog(file);
    assert.equal(log.record({ site: 'x', hex64: [HEX_A] }), true);
    fs.appendFileSync(file, 'CORRUPT\n');
    assert.equal(log.record({ site: 'x', hex64: [HEX_B] }), true);
    const all = log.readAll();
    assert.equal(all.length, 2);
    assert.ok(all.every((r) => r.ts > 0));
});
