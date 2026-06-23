// Coach/kiosk auth — one Serverless Function handling the whole gym
// username/password feature (kept as a single function to stay within the
// Vercel Hobby 12-function limit). Routes on body `action`:
//   login              (public)  username+password  -> coach + kiosk tokens
//   refresh            (public)  roomId+kioskToken  -> fresh coach room token
//   credentials-get    (owner)   -> { username }
//   credentials-set    (owner)   username+password  -> save
//   credentials-clear  (owner)   -> disable coach login
const { applyCors } = require('./_lib/cors');
const { adminClient } = require('./_lib/supabase');
const { requireCaller, resolveOwnedGym } = require('./_lib/auth');
const { checkGymLoginRate } = require('./_lib/rate-limit');
const { signRoomToken, verifyRoomToken } = require('../lib/room-token');
const { hashPassword, verifyPassword } = require('../lib/kiosk-password');

const ROOM_TOKEN_TTL_MS  = 12 * 60 * 60 * 1000;
const KIOSK_TOKEN_TTL_MS  = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function paywallBlocked(gym) {
  const status = gym.subscription_status;
  const trialExpired = status === 'trial' && gym.trial_ends_at && new Date(gym.trial_ends_at) < new Date();
  return status === 'canceled' || trialExpired;
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.PARTY_AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: 'Room auth is not configured' });

  const body = req.body || {};
  const action = body.action;
  const admin = adminClient();

  // ── Public: coach login ──────────────────────────────────────────
  if (action === 'login') {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const { allowed } = await checkGymLoginRate(admin, ip);
    if (!allowed) return res.status(429).json({ error: 'Too many sign-in attempts. Please try again shortly.' });

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const { data: gym } = await admin
      .from('gyms')
      .select('id, room_code, name, subscription_status, trial_ends_at, kiosk_password_hash, kiosk_password_salt')
      .eq('kiosk_username', username)
      .maybeSingle();

    // Same message for unknown user vs wrong password — no enumeration.
    if (!gym || !gym.kiosk_password_hash || !(await verifyPassword(password, gym.kiosk_password_hash, gym.kiosk_password_salt))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (paywallBlocked(gym)) return res.status(402).json({ error: 'Subscription required' });

    const sub = `gym:${gym.id}`;
    const roomTokenExp  = Date.now() + ROOM_TOKEN_TTL_MS;
    const kioskTokenExp = Date.now() + KIOSK_TOKEN_TTL_MS;
    const roomToken  = await signRoomToken({ room: gym.room_code, role: 'coach',      sub, exp: roomTokenExp }, secret);
    const kioskToken = await signRoomToken({ room: gym.room_code, role: 'kiosk-auth', sub, exp: kioskTokenExp }, secret);
    return res.status(200).json({ roomCode: gym.room_code, gymName: gym.name, roomToken, roomTokenExp, kioskToken, kioskTokenExp });
  }

  // ── Public: refresh a kiosk session's room token ─────────────────
  if (action === 'refresh') {
    const roomId = String(body.roomId || '').trim().toUpperCase();
    const kioskToken = body.kioskToken;
    if (!roomId || !kioskToken) return res.status(400).json({ error: 'roomId and kioskToken required' });

    const payload = await verifyRoomToken(kioskToken, secret, roomId);
    if (!payload || payload.role !== 'kiosk-auth' || !payload.sub?.startsWith('gym:')) {
      return res.status(401).json({ error: 'Invalid or expired coach login' });
    }
    const gymId = payload.sub.slice('gym:'.length);
    const { data: gym } = await admin
      .from('gyms')
      .select('id, room_code, subscription_status, trial_ends_at, kiosk_username')
      .eq('id', gymId)
      .maybeSingle();
    if (!gym || gym.room_code?.toUpperCase() !== roomId) {
      return res.status(403).json({ error: 'Coach login is no longer available for this gym.' });
    }
    if (!gym.kiosk_username) return res.status(403).json({ error: 'Coach login has been turned off. Ask your gym owner.' });
    if (paywallBlocked(gym)) return res.status(402).json({ error: 'Subscription required' });

    const exp = Date.now() + ROOM_TOKEN_TTL_MS;
    const roomToken = await signRoomToken({ room: roomId, role: 'coach', sub: payload.sub, exp }, secret);
    return res.status(200).json({ roomToken, roomTokenExp: exp });
  }

  // ── Owner-only: manage the gym credentials ───────────────────────
  if (action === 'credentials-get' || action === 'credentials-set' || action === 'credentials-clear') {
    const auth = await requireCaller(req, res);
    if (!auth) return;
    const roomId = String(body.roomId || '').trim().toUpperCase();
    const gym = await resolveOwnedGym(auth, res, roomId, {
      select: 'id, kiosk_username',
      forbiddenMsg: 'Only gym owners can manage coach login',
    });
    if (!gym) return;

    if (action === 'credentials-get') {
      return res.status(200).json({ username: gym.kiosk_username || null });
    }
    if (action === 'credentials-clear') {
      const { error } = await admin.from('gyms').update({
        kiosk_username: null, kiosk_password_hash: null, kiosk_password_salt: null, kiosk_updated_at: new Date().toISOString(),
      }).eq('id', gym.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ username: null });
    }
    // credentials-set
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters: lowercase letters, numbers, dot, dash or underscore (no spaces or @).' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { data: taken } = await admin
      .from('gyms').select('id').eq('kiosk_username', username).neq('id', gym.id).maybeSingle();
    if (taken) return res.status(409).json({ error: 'That username is taken — try another.' });

    const { hash, salt } = await hashPassword(password);
    const { error } = await admin.from('gyms').update({
      kiosk_username: username, kiosk_password_hash: hash, kiosk_password_salt: salt, kiosk_updated_at: new Date().toISOString(),
    }).eq('id', gym.id);
    if (error) {
      if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message || '')) {
        return res.status(409).json({ error: 'That username is taken — try another.' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ username });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
