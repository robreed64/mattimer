const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signRoomToken, verifyRoomToken } = require('../lib/room-token');

const SECRET = 'test-secret-with-enough-entropy-123456';
const payload = () => ({ room: 'ABC123', role: 'owner', sub: 'user-1', exp: Date.now() + 60_000 });

test('round-trip: signed token verifies for its room', async () => {
  const token = await signRoomToken(payload(), SECRET);
  const out = await verifyRoomToken(token, SECRET, 'ABC123');
  assert.equal(out.role, 'owner');
  assert.equal(out.sub, 'user-1');
});

test('rejects expired tokens', async () => {
  const token = await signRoomToken({ ...payload(), exp: Date.now() - 1000 }, SECRET);
  assert.equal(await verifyRoomToken(token, SECRET, 'ABC123'), null);
});

test('rejects wrong room', async () => {
  const token = await signRoomToken(payload(), SECRET);
  assert.equal(await verifyRoomToken(token, SECRET, 'XYZ789'), null);
});

test('rejects tampered payload', async () => {
  const token = await signRoomToken(payload(), SECRET);
  const [body, sig] = token.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
  forged.role = 'admin';
  const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
  assert.equal(await verifyRoomToken(`${forgedBody}.${sig}`, SECRET, 'ABC123'), null);
});

test('rejects wrong secret and garbage input', async () => {
  const token = await signRoomToken(payload(), SECRET);
  assert.equal(await verifyRoomToken(token, 'other-secret', 'ABC123'), null);
  assert.equal(await verifyRoomToken('not-a-token', SECRET, 'ABC123'), null);
  assert.equal(await verifyRoomToken('', SECRET, 'ABC123'), null);
  assert.equal(await verifyRoomToken(null, SECRET, 'ABC123'), null);
  assert.equal(await verifyRoomToken('a.b', SECRET, 'ABC123'), null);
});
