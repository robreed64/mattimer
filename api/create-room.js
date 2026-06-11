const { makeCode } = require('../lib/room-code');
const { applyCors } = require('./_lib/cors');
const { requireCaller, resolveOwnedGym } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST, DELETE, OPTIONS')) return;

  const auth = await requireCaller(req, res);
  if (!auth) return;

  const roomId = (req.method === 'GET' ? req.query : req.body || {}).roomId;
  const gym = await resolveOwnedGym(auth, res, roomId, {
    forbiddenMsg: 'Only gym owners can manage rooms',
  });
  if (!gym) return;
  const { admin } = auth;

  if (req.method === 'GET') {
    const { data: rooms } = await admin
      .from('gym_rooms')
      .select('id, name, room_code')
      .eq('gym_id', gym.id)
      .order('created_at');
    return res.status(200).json({ rooms: rooms || [] });
  }

  if (req.method === 'POST') {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Room name required' });

    let code, insertErr, attempts = 0;
    do {
      code = makeCode();
      ({ error: insertErr } = await admin
        .from('gym_rooms')
        .insert({ gym_id: gym.id, name: name.trim(), room_code: code }));
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
      .eq('gym_id', gym.id); // scope to caller's gym

    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
