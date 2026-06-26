const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roundProgress } = require('../public/js/progress.js');

test('full fight round → fraction 1', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 300 }), 1);
});

test('half a fight round → 0.5', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 150 }), 0.5);
});

test('rest phase uses restDuration', () => {
  assert.equal(roundProgress({ phase: 'rest', roundDuration: 300, restDuration: 60, timeRemaining: 30 }), 0.5);
});

test('empty round → 0', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 0 }), 0);
});

test('timeRemaining greater than full clamps to 1', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 400 }), 1);
});

test('negative timeRemaining clamps to 0', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: -5 }), 0);
});

test('zero-duration guard returns 0 (no divide-by-zero)', () => {
  assert.equal(roundProgress({ phase: 'rest', roundDuration: 300, restDuration: 0, timeRemaining: 0 }), 0);
});
