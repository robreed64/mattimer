const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCode, CHARS } = require('../lib/room-code');

test('makeCode returns 6 chars from the safe charset', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeCode();
    assert.equal(code.length, 6);
    for (const ch of code) assert.ok(CHARS.includes(ch), `unexpected char ${ch}`);
  }
});

test('charset excludes ambiguous characters', () => {
  for (const ch of '01IO') assert.ok(!CHARS.includes(ch), `${ch} should be excluded`);
});

test('codes vary across calls', () => {
  const codes = new Set(Array.from({ length: 100 }, makeCode));
  assert.ok(codes.size > 90, `expected high uniqueness, got ${codes.size}/100`);
});
