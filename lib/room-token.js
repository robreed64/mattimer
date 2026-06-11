// Room access tokens: minted by api/room-token.js after Supabase membership
// checks, verified statelessly by party/main.js. Uses only WebCrypto
// (globalThis.crypto) so the same file runs on Node 18+, workerd, and tests.
// Format: base64url(JSON payload) + '.' + base64url(HMAC-SHA256 of that string).
// Payload: { room, role: 'owner'|'coach'|'admin', sub: userId, exp: epoch ms }

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, usages
  );
}

async function signRoomToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key  = await hmacKey(secret, ['sign']);
  const sig  = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

// Returns the payload if the token is valid for `room` and unexpired, else null.
async function verifyRoomToken(token, secret, room) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let sig, payload;
  try {
    sig = b64urlToBytes(sigPart);
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }

  const key = await hmacKey(secret, ['verify']);
  const ok  = await crypto.subtle.verify('HMAC', key, sig, enc.encode(body));
  if (!ok) return null;
  if (!payload || payload.room !== room) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

module.exports = { signRoomToken, verifyRoomToken };
