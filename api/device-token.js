// Exchanges a paired phone's long-lived device-auth token for a fresh 12h
// room token — lets a returning coach skip rescanning the pairing QR.
// Mirrors api/room-token.js but authenticates the device token instead of
// a Supabase JWT, and additionally checks the gym_devices revocation flag.
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
  const deviceToken = (req.body || {}).deviceToken;
  if (!roomId || !deviceToken) return res.status(400).json({ error: 'roomId and deviceToken required' });

  const payload = await verifyRoomToken(deviceToken, secret, roomId);
  if (!payload || payload.role !== 'device-auth' || !payload.sub?.startsWith('device:')) {
    return res.status(401).json({ error: 'Invalid or expired device token' });
  }
  const deviceId = payload.sub.slice('device:'.length);

  const admin = adminClient();
  const { data: device } = await admin
    .from('gym_devices')
    .select('id, revoked_at')
    .eq('id', deviceId)
    .single();
  if (!device || device.revoked_at) {
    return res.status(403).json({ error: 'This device has been removed. Pair again from the gym display.' });
  }

  admin.from('gym_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', deviceId).then(() => {}, () => {});

  const exp = Date.now() + ROOM_TOKEN_TTL_MS;
  const roomToken = await signRoomToken({ room: roomId, role: 'coach', sub: payload.sub, exp }, secret);
  return res.status(200).json({ roomToken, roomTokenExp: exp });
};
