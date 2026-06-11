// Mints a short-lived HMAC room token after verifying the caller's Supabase
// session and gym membership. party/main.js verifies it statelessly with the
// same PARTY_AUTH_SECRET — that is what authorizes controller websockets and
// the per-room REST API.
const { signRoomToken } = require('../lib/room-token');
const { applyCors } = require('./_lib/cors');
const { requireCaller } = require('./_lib/auth');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.PARTY_AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: 'Room auth is not configured' });

  const auth = await requireCaller(req, res);
  if (!auth) return;
  const { admin, caller, isAdmin } = auth;

  const roomId = String((req.body || {}).roomId || '').trim().toUpperCase();
  if (!roomId) return res.status(400).json({ error: 'roomId required' });

  let role;
  if (isAdmin) {
    role = 'admin';
  } else {
    const { data: membership } = await admin
      .from('gym_users')
      .select('gym_id, role')
      .eq('user_id', caller.id)
      .single();
    if (!membership) return res.status(403).json({ error: 'No gym assigned to your account' });

    const { data: gym } = await admin
      .from('gyms')
      .select('id, room_code, subscription_status, trial_ends_at')
      .eq('id', membership.gym_id)
      .single();
    if (!gym) return res.status(404).json({ error: 'Gym not found' });

    // The room must be the gym's main room or one of its extra rooms
    let allowed = gym.room_code?.toUpperCase() === roomId;
    if (!allowed) {
      const { data: extra } = await admin
        .from('gym_rooms')
        .select('id')
        .eq('gym_id', gym.id)
        .eq('room_code', roomId)
        .single();
      allowed = !!extra;
    }
    if (!allowed) return res.status(403).json({ error: 'That room does not belong to your gym' });

    // Server-side paywall: no controller access for canceled or trial-expired gyms
    const status = gym.subscription_status;
    const trialExpired = status === 'trial'
      && gym.trial_ends_at && new Date(gym.trial_ends_at) < new Date();
    if (status === 'canceled' || trialExpired) {
      return res.status(402).json({ error: 'Subscription required' });
    }

    role = membership.role;
  }

  const exp = Date.now() + TOKEN_TTL_MS;
  const token = await signRoomToken({ room: roomId, role, sub: caller.id, exp }, secret);
  return res.status(200).json({ token, exp });
};
