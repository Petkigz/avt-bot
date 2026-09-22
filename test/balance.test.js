const test = require('node:test');
const assert = require('node:assert');
const { parseBalance } = require('../util/balance');

test('parses plain numbers', () => {
    assert.strictEqual(parseBalance('500'), 500);
    assert.strictEqual(parseBalance('123.45'), 123.45);
});

test('strips currency symbols and thousands commas', () => {
    assert.strictEqual(parseBalance('KSh 1,234.56'), 1234.56);
    assert.strictEqual(parseBalance('$1,000,000'), 1000000);
});

test('handles decimal comma', () => {
    assert.strictEqual(parseBalance('1000,50'), 1000.5);
});

test('handles European style 1.234,56', () => {
    assert.strictEqual(parseBalance('1.234,56'), 1234.56);
});

test('returns null for unparseable input', () => {
    assert.strictEqual(parseBalance(''), null);
    assert.strictEqual(parseBalance(null), null);
    assert.strictEqual(parseBalance('Balance unavailable'), null);
    assert.strictEqual(parseBalance('---'), null);
});
