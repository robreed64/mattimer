// Coach-profile PIN hashing. WebCrypto PBKDF2-HMAC-SHA256 so the same file
// runs in party/main.js (workerd), Node, and tests. Iterations are kept
// modest for Durable Object CPU limits — for 4-digit PINs the lockout in
// party/main.js is the real defense, not hash cost.
const ITERATIONS = 30000;
const enc = new TextEncoder();

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function derive(pin, saltBytes) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: ITERATIONS },
    key, 256
  );
  return toHex(new Uint8Array(bits));
}

// Returns { pinHash, pinSalt } (hex strings) for storage on the profile.
async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { pinHash: await derive(pin, salt), pinSalt: toHex(salt) };
}

async function verifyPin(pin, pinHash, pinSalt) {
  if (!pinHash || !pinSalt) return false;
  return (await derive(pin, fromHex(pinSalt))) === pinHash;
}

module.exports = { hashPin, verifyPin };
