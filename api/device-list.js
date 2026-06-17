// Lists paired devices for the owner's "Paired Devices" panel (replaces
// the old per-coach email-invite list, since coaches no longer have their
// own Supabase accounts under the pairing-code flow).
const { applyCors } = require('./_lib/cors');
const { requireCaller } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireCaller(req, res);
  if (!auth) return;
  const { admin, caller, isAdmin } = auth;

  let gymId;
  if (isAdmin) {
    gymId = String(req.query?.gymId || '').trim();
    if (!gymId) return res.status(400).json({ error: 'gymId required' });
  } else {
    const { data: membership } = await admin.from('gym_users').select('gym_id, role').eq('user_id', caller.id).single();
    if (!membership || membership.role !== 'owner') {
      return res.status(403).json({ error: 'Only gym owners can view paired devices' });
    }
    gymId = membership.gym_id;
  }

  const { data, error } = await admin
    .from('gym_devices')
    .select('id, room_code, label, created_at, last_seen_at, revoked_at')
    .eq('gym_id', gymId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ devices: data || [] });
};
