// Exchanges a kiosk's long-lived kiosk-auth token for a fresh 12h coach room
// token — lets a shared gym device stay signed in across reloads/expiry without
// re-entering the gym password. Mirrors api/device-token.js.
const { applyCors } = require('./_lib/cors');
const { adminClient } = require('./_lib/supabase');
const { signRoomToken, verifyRoomToken } = require('../lib/room-token');

const ROOM_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.PARTY_AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: 'Room auth is not configured' });

  const roomId = String((req.body || {}).roomId || '').trim().toUpperCase();
  const kioskToken = (req.body || {}).kioskToken;
  if (!roomId || !kioskToken) return res.status(400).json({ error: 'roomId and kioskToken required' });

  const payload = await verifyRoomToken(kioskToken, secret, roomId);
  if (!payload || payload.role !== 'kiosk-auth' || !payload.sub?.startsWith('gym:')) {
    return res.status(401).json({ error: 'Invalid or expired coach login' });
  }
  const gymId = payload.sub.slice('gym:'.length);

  const admin = adminClient();
  const { data: gym } = await admin
    .from('gyms')
    .select('id, room_code, subscription_status, trial_ends_at, kiosk_username')
    .eq('id', gymId)
    .maybeSingle();
  if (!gym || gym.room_code?.toUpperCase() !== roomId) {
    return res.status(403).json({ error: 'Coach login is no longer available for this gym.' });
  }
  // Owner cleared the coach login → stop refreshing.
  if (!gym.kiosk_username) {
    return res.status(403).json({ error: 'Coach login has been turned off. Ask your gym owner.' });
  }
  const status = gym.subscription_status;
  const trialExpired = status === 'trial' && gym.trial_ends_at && new Date(gym.trial_ends_at) < new Date();
  if (status === 'canceled' || trialExpired) return res.status(402).json({ error: 'Subscription required' });

  const exp = Date.now() + ROOM_TOKEN_TTL_MS;
  const roomToken = await signRoomToken({ room: roomId, role: 'coach', sub: payload.sub, exp }, secret);
  return res.status(200).json({ roomToken, roomTokenExp: exp });
};
