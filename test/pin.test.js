const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPin, verifyPin } = require('../lib/pin');

test('hash/verify round-trip', async () => {
  const { pinHash, pinSalt } = await hashPin('1234');
  assert.ok(await verifyPin('1234', pinHash, pinSalt));
  assert.ok(!(await verifyPin('4321', pinHash, pinSalt)));
});

test('same pin hashes differently per salt', async () => {
  const a = await hashPin('1234');
  const b = await hashPin('1234');
  assert.notEqual(a.pinHash, b.pinHash);
  assert.notEqual(a.pinSalt, b.pinSalt);
});

test('verify fails gracefully on missing hash/salt', async () => {
  assert.ok(!(await verifyPin('1234', '', '')));
  assert.ok(!(await verifyPin('1234', null, null)));
});

test('numeric input is coerced to string', async () => {
  const { pinHash, pinSalt } = await hashPin(1234);
  assert.ok(await verifyPin('1234', pinHash, pinSalt));
});
