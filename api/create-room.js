const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!callerJwt) return res.status(401).json({ error: 'Not authenticated' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user: caller }, error: authErr } = await admin.auth.getUser(callerJwt);
  if (authErr || !caller) return res.status(401).json({ error: 'Invalid session' });

  const { data: membership } = await admin
    .from('gym_users')
    .select('gym_id, role')
    .eq('user_id', caller.id)
    .single();

  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ error: 'Only gym owners can manage rooms' });
  }

  if (req.method === 'POST') {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Room name required' });

    let code, insertErr, attempts = 0;
    do {
      code = makeCode();
      ({ error: insertErr } = await admin
        .from('gym_rooms')
        .insert({ gym_id: membership.gym_id, name: name.trim(), room_code: code }));
      attempts++;
    } while (insertErr?.code === '23505' && attempts < 5); // retry on rare code collision

    if (insertErr) return res.status(500).json({ error: insertErr.message });
    return res.status(200).json({ ok: true, code, name: name.trim() });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Room id required' });

    const { error: delErr } = await admin
      .from('gym_rooms')
      .delete()
      .eq('id', id)
      .eq('gym_id', membership.gym_id); // scope to caller's gym

    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
