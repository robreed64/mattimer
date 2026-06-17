// Mints a short-lived, single-use pairing code so a coach's phone can join
// a room by scanning a barcode instead of creating its own Supabase
// account. Only the gym owner's authenticated browser may generate one —
// see api/pairing-redeem.js for how a phone exchanges the code for access.
const crypto = require('crypto');
const { applyCors } = require('./_lib/cors');
const { requireCaller } = require('./_lib/auth');
const { SITE_URL } = require('./_lib/supabase');

const CODE_TTL_MS = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireCaller(req, res);
  if (!auth) return;
  const { admin, caller, isAdmin } = auth;

  const roomId = String((req.body || {}).roomId || '').trim().toUpperCase();
  if (!roomId) return res.status(400).json({ error: 'roomId required' });

  let gym;
  if (isAdmin) {
    const { data } = await admin.from('gyms').select('id, room_code, subscription_status, trial_ends_at').eq('room_code', roomId).single();
    gym = data;
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
  } else {
    const { data: membership } = await admin
      .from('gym_users')
      .select('gym_id, role')
      .eq('user_id', caller.id)
      .single();
    if (!membership || membership.role !== 'owner') {
      return res.status(403).json({ error: 'Only gym owners can generate a pairing code' });
    }

    const { data } = await admin
      .from('gyms')
      .select('id, room_code, subscription_status, trial_ends_at')
      .eq('id', membership.gym_id)
      .single();
    gym = data;
    if (!gym) return res.status(404).json({ error: 'Gym not found' });

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

    const status = gym.subscription_status;
    const trialExpired = status === 'trial' && gym.trial_ends_at && new Date(gym.trial_ends_at) < new Date();
    if (status === 'canceled' || trialExpired) {
      return res.status(402).json({ error: 'Subscription required' });
    }
  }

  const code = crypto.randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const { error } = await admin
    .from('pairing_codes')
    .insert({ gym_id: gym.id, room_code: roomId, code, expires_at: expiresAt });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ code, url: `${SITE_URL}?pair=${code}`, expiresAt });
};
