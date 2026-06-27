#!/usr/bin/env node
// Diagnose room-token auth config: confirms PARTY_AUTH_SECRET produces tokens
// that verify against itself, and flags the hidden-whitespace gotcha that makes
// two "identical-looking" secrets fail HMAC verification (enc.encode is
// byte-exact, so "abc\n" !== "abc"). See reference: REQUIRE_AUTH lockout.
//
// Usage:
//   PARTY_AUTH_SECRET=... node scripts/check-room-token.js
//   PARTY_AUTH_SECRET=... node scripts/check-room-token.js <token>   # verify a real minted token
//
// Typical flow:
//   vercel env pull .env.vercel.tmp
//   set -a; . ./.env.vercel.tmp; set +a
//   node scripts/check-room-token.js
//
// Exit code 0 = all checks passed, 1 = something failed (CI-friendly).

const { signRoomToken, verifyRoomToken } = require('../lib/room-token');

function b64urlDecode(str) {
  const bin = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('binary');
  return Buffer.from(bin, 'binary').toString('utf8');
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

(async () => {
  let ok = true;
  const secret = process.env.PARTY_AUTH_SECRET;

  console.log('PARTY_AUTH_SECRET diagnostic');
  if (!secret) {
    console.log('  present:             NO  — set it before running (e.g. `vercel env pull` then source it)');
    process.exit(1);
  }
  const leading = /^\s/.test(secret);
  const trailing = /\s$/.test(secret);
  console.log('  present:             yes');
  console.log('  length:             ', secret.length);
  console.log('  leading whitespace: ', leading ? 'YES  <-- likely breaks verification' : 'no');
  console.log('  trailing whitespace:', trailing ? 'YES  <-- likely breaks verification' : 'no');
  if (leading || trailing) ok = false;

  // Round-trip: sign then verify with the same secret. This must pass for any
  // non-empty secret; a failure means WebCrypto/HMAC itself is unavailable.
  const token = await signRoomToken({ room: 'DIAG', role: 'owner', sub: 'diag', exp: Date.now() + 10000 }, secret);
  const roundTrip = await verifyRoomToken(token, secret, 'DIAG');
  console.log('  round-trip:         ', roundTrip ? 'PASS' : 'FAIL');
  if (!roundTrip) ok = false;

  // Optional: verify a real minted token against THIS secret.
  const arg = process.argv[2];
  if (arg) {
    const real = arg.replace(/^Bearer\s+/i, '').trim();
    console.log('\nToken check');
    let payload = null;
    try {
      payload = JSON.parse(b64urlDecode(real.slice(0, real.indexOf('.'))));
    } catch {
      console.log('  decodes:             NO  — not a well-formed room token');
      process.exit(1);
    }
    const expIn = payload.exp - Date.now();
    console.log('  decodes:             yes');
    console.log('  room:               ', payload.room);
    console.log('  role:               ', payload.role);
    console.log('  expired:            ', expIn <= 0 ? 'YES' : `no (expires in ${fmtDuration(expIn)})`);
    const verified = await verifyRoomToken(real, secret, payload.room);
    console.log('  verifies w/ secret: ', verified ? 'PASS — this secret matches the one that signed the token' : 'FAIL — wrong secret (or expired/tampered)');
    if (!verified) ok = false;
  }

  console.log(ok ? '\nAll checks passed.' : '\nProblems found — see flagged lines above.');
  process.exit(ok ? 0 : 1);
})();
