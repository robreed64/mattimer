// Strong password hashing for the gym "coach login" credential. Unlike lib/pin.js
// (deliberately light PBKDF2 for 4-digit PINs under workerd CPU limits, backed by a
// lockout), this is the primary credential and runs in Node Vercel functions, so use
// scrypt with a real work factor and a constant-time compare.
const crypto = require('crypto');

const KEYLEN = 32;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function _scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEYLEN, SCRYPT, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = await _scrypt(password, salt);
  return { hash: dk.toString('hex'), salt };
}

async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  let dk;
  try { dk = await _scrypt(password, salt); } catch { return false; }
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== dk.length) return false;
  return crypto.timingSafeEqual(expected, dk);
}

module.exports = { hashPassword, verifyPassword };
