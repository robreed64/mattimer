// Shared by api/* (Vercel, CJS require) and party/main.js (esbuild CJS interop).
// Charset excludes 0/O/1/I to keep codes readable on gym TVs.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
}

module.exports = { makeCode, CHARS };
