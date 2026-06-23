// Owner-only: read / set / clear the gym's shared "coach login" (username +
// password) that lets coaches sign in on a shared gym device without an email
// account. The credential mints a coach-role session via api/gym-login.js.
const { applyCors } = require('./_lib/cors');
const { requireCaller, resolveOwnedGym } = require('./_lib/auth');
const { hashPassword } = require('../lib/kiosk-password');

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

module.exports = async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST, OPTIONS')) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireCaller(req, res);
  if (!auth) return;

  // Owners act on their own gym; platform admins may pass ?roomId / {roomId}.
  const roomId = String((req.query && req.query.roomId) || (req.body || {}).roomId || '').trim().toUpperCase();
  const gym = await resolveOwnedGym(auth, res, roomId, {
    select: 'id, kiosk_username',
    forbiddenMsg: 'Only gym owners can manage coach login',
  });
  if (!gym) return;
  const { admin } = auth;

  if (req.method === 'GET') {
    return res.status(200).json({ username: gym.kiosk_username || null });
  }

  const body = req.body || {};

  if (body.clear === true) {
    const { error } = await admin.from('gyms').update({
      kiosk_username: null, kiosk_password_hash: null, kiosk_password_salt: null,
      kiosk_updated_at: new Date().toISOString(),
    }).eq('id', gym.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ username: null });
  }

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters: lowercase letters, numbers, dot, dash or underscore (no spaces or @).' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  // The unique index is the real guard; pre-check to give a friendly message.
  const { data: taken } = await admin
    .from('gyms').select('id').eq('kiosk_username', username).neq('id', gym.id).maybeSingle();
  if (taken) return res.status(409).json({ error: 'That username is taken — try another.' });

  const { hash, salt } = await hashPassword(password);
  const { error } = await admin.from('gyms').update({
    kiosk_username: username, kiosk_password_hash: hash, kiosk_password_salt: salt,
    kiosk_updated_at: new Date().toISOString(),
  }).eq('id', gym.id);
  if (error) {
    if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message || '')) {
      return res.status(409).json({ error: 'That username is taken — try another.' });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ username });
};
