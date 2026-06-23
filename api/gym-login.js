// Coach/kiosk login: verify a gym's shared username + password and mint a
// coach-role room token (no Supabase account needed), plus a long-lived
// kiosk-auth token the device stores to refresh later via api/kiosk-token.js.
// Mirrors api/pairing-redeem.js but authenticates by gym credentials.
const { applyCors } = require('./_lib/cors');
const { adminClient } = require('./_lib/supabase');
const { checkGymLoginRate } = require('./_lib/rate-limit');
const { signRoomToken } = require('../lib/room-token');
const { verifyPassword } = require('../lib/kiosk-password');

const ROOM_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const KIOSK_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.PARTY_AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: 'Room auth is not configured' });

  const admin = adminClient();

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const { allowed } = await checkGymLoginRate(admin, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many sign-in attempts. Please try again shortly.' });

  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const { data: gym } = await admin
    .from('gyms')
    .select('id, room_code, name, subscription_status, trial_ends_at, kiosk_password_hash, kiosk_password_salt')
    .eq('kiosk_username', username)
    .maybeSingle();

  // Same message for unknown user vs wrong password — no username enumeration.
  if (!gym || !gym.kiosk_password_hash || !(await verifyPassword(password, gym.kiosk_password_hash, gym.kiosk_password_salt))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Server-side paywall (mirror api/room-token.js): no access for canceled or
  // trial-expired gyms.
  const status = gym.subscription_status;
  const trialExpired = status === 'trial' && gym.trial_ends_at && new Date(gym.trial_ends_at) < new Date();
  if (status === 'canceled' || trialExpired) return res.status(402).json({ error: 'Subscription required' });

  const sub = `gym:${gym.id}`;
  const roomTokenExp = Date.now() + ROOM_TOKEN_TTL_MS;
  const kioskTokenExp = Date.now() + KIOSK_TOKEN_TTL_MS;
  const roomToken = await signRoomToken({ room: gym.room_code, role: 'coach', sub, exp: roomTokenExp }, secret);
  const kioskToken = await signRoomToken({ room: gym.room_code, role: 'kiosk-auth', sub, exp: kioskTokenExp }, secret);

  return res.status(200).json({
    roomCode: gym.room_code, gymName: gym.name,
    roomToken, roomTokenExp, kioskToken, kioskTokenExp,
  });
};
