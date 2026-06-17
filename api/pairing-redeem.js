// Exchanges a one-time pairing code (scanned from the gym's display QR)
// for room access — no Supabase account needed on the phone. Returns a
// normal 12h room token plus a long-lived device-auth token the phone
// stores so it can mint fresh room tokens later via api/device-token.js
// without rescanning. See api/pairing-create.js for how codes are minted.
const { applyCors } = require('./_lib/cors');
const { adminClient } = require('./_lib/supabase');
const { checkPairingRate } = require('./_lib/rate-limit');
const { signRoomToken } = require('../lib/room-token');

const ROOM_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.PARTY_AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: 'Room auth is not configured' });

  const admin = adminClient();

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const { allowed } = await checkPairingRate(admin, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many pairing attempts. Please try again shortly.' });

  const code = String((req.body || {}).code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });

  const { data: pairing } = await admin
    .from('pairing_codes')
    .select('id, gym_id, room_code, expires_at, used_at')
    .eq('code', code)
    .single();
  if (!pairing) return res.status(404).json({ error: 'Invalid pairing code' });
  if (pairing.used_at) return res.status(410).json({ error: 'This pairing code has already been used' });
  if (new Date(pairing.expires_at) < new Date()) return res.status(410).json({ error: 'This pairing code has expired' });

  // Atomically consume the code: the is('used_at', null) guard means only
  // one of two concurrent redeem attempts can win this update.
  const { data: consumed, error: consumeErr } = await admin
    .from('pairing_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', pairing.id)
    .is('used_at', null)
    .select('id');
  if (consumeErr) return res.status(500).json({ error: consumeErr.message });
  if (!consumed || consumed.length === 0) {
    return res.status(410).json({ error: 'This pairing code has already been used' });
  }

  const { data: device, error: deviceErr } = await admin
    .from('gym_devices')
    .insert({ gym_id: pairing.gym_id, room_code: pairing.room_code })
    .select('id')
    .single();
  if (deviceErr) return res.status(500).json({ error: deviceErr.message });

  const sub = `device:${device.id}`;
  const roomTokenExp = Date.now() + ROOM_TOKEN_TTL_MS;
  const roomToken = await signRoomToken({ room: pairing.room_code, role: 'coach', sub, exp: roomTokenExp }, secret);
  const deviceToken = await signRoomToken({ room: pairing.room_code, role: 'device-auth', sub, exp: Date.now() + DEVICE_TOKEN_TTL_MS }, secret);

  return res.status(200).json({
    roomToken, roomTokenExp,
    deviceToken, roomCode: pairing.room_code, deviceId: device.id,
  });
};
