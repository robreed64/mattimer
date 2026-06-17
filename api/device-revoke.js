// Lets a gym owner kick a paired phone (lost device, departed coach).
// Revocation is enforced on next refresh by api/device-token.js — the
// device's current 12h room token (if any) still works until it expires.
const { applyCors } = require('./_lib/cors');
const { requireCaller } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireCaller(req, res);
  if (!auth) return;
  const { admin, caller, isAdmin } = auth;

  const deviceId = String((req.body || {}).deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const { data: device } = await admin.from('gym_devices').select('id, gym_id').eq('id', deviceId).single();
  if (!device) return res.status(404).json({ error: 'Device not found' });

  if (!isAdmin) {
    const { data: membership } = await admin
      .from('gym_users')
      .select('gym_id, role')
      .eq('user_id', caller.id)
      .single();
    if (!membership || membership.role !== 'owner' || membership.gym_id !== device.gym_id) {
      return res.status(403).json({ error: 'You are not the owner of that device\'s gym' });
    }
  }

  const { error } = await admin.from('gym_devices').update({ revoked_at: new Date().toISOString() }).eq('id', deviceId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
};
