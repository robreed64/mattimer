const { adminClient } = require('./supabase');

// Verifies the caller's Supabase JWT. On failure sends a 401 and returns null.
// `admin` is injectable for tests.
async function requireCaller(req, res, admin = adminClient()) {
  const jwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!jwt) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  const { data, error } = await admin.auth.getUser(jwt);
  const caller = data?.user;
  if (error || !caller) {
    res.status(401).json({ error: 'Invalid session' });
    return null;
  }
  return { admin, caller, isAdmin: caller.app_metadata?.role === 'admin' };
}

// Resolves the gym the caller may act on: platform admins pass a roomId
// (gyms.room_code), owners act on their own gym. On failure sends the
// error response and returns null.
async function resolveOwnedGym({ admin, caller, isAdmin }, res, roomId, {
  select = 'id',
  forbiddenMsg = 'Only gym owners can do this',
} = {}) {
  if (isAdmin) {
    if (!roomId) {
      res.status(400).json({ error: 'roomId required' });
      return null;
    }
    const { data: gym } = await admin.from('gyms').select(select).eq('room_code', roomId).single();
    if (!gym) {
      res.status(404).json({ error: 'Gym not found' });
      return null;
    }
    return gym;
  }

  const { data: membership, error: memErr } = await admin
    .from('gym_users')
    .select('gym_id, role')
    .eq('user_id', caller.id)
    .single();
  if (memErr || !membership || membership.role !== 'owner') {
    res.status(403).json({ error: forbiddenMsg, detail: memErr?.message });
    return null;
  }
  const { data: gym } = await admin.from('gyms').select(select).eq('id', membership.gym_id).single();
  if (!gym) {
    res.status(404).json({ error: 'Gym not found' });
    return null;
  }
  return gym;
}

// True if the caller is an owner of the given gym id.
async function isOwnerOfGym(admin, callerId, gymId) {
  const { data: membership } = await admin
    .from('gym_users')
    .select('role')
    .eq('gym_id', gymId)
    .eq('user_id', callerId)
    .single();
  return membership?.role === 'owner';
}

module.exports = { requireCaller, resolveOwnedGym, isOwnerOfGym };
