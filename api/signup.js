const { makeCode } = require('../lib/room-code');
const { adminClient, SITE_URL } = require('./_lib/supabase');
const { applyCors } = require('./_lib/cors');
const { checkSignupRate } = require('./_lib/rate-limit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, gymName, website, referredBy } = req.body || {};
  const email = String((req.body || {}).email || '').trim().toLowerCase();

  // Honeypot: the hidden "website" field is invisible to humans — bots that
  // fill it get a fake success and no rows.
  if (website) return res.status(200).json({ ok: true });

  if (!name?.trim() || !gymName?.trim() || !email) {
    return res.status(400).json({ error: 'Your name, gym name, and email are all required.' });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'That email address doesn’t look valid.' });
  }
  if (name.trim().length > 100 || gymName.trim().length > 100) {
    return res.status(400).json({ error: 'Name and gym name must be under 100 characters.' });
  }

  const admin = adminClient();

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const { allowed } = await checkSignupRate(admin, ip);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many signup attempts. Please try again in an hour.' });
  }

  // Generate a unique room code (collisions are astronomically rare but handle them)
  let roomCode;
  for (let i = 0; i < 10; i++) {
    const candidate = makeCode();
    const { data: clash } = await admin.from('gyms').select('id').eq('room_code', candidate).single();
    if (!clash) { roomCode = candidate; break; }
  }
  if (!roomCode) return res.status(500).json({ error: 'Could not generate a room code. Please try again.' });

  // Create the user first: generateLink surfaces "email already exists",
  // so duplicate signups fail before any gym rows are created.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: `${SITE_URL}?room=${roomCode}` },
  });

  if (linkErr) {
    const msg = linkErr.message?.toLowerCase().includes('already')
      ? 'An account with that email already exists. Try signing in instead.'
      : linkErr.message;
    return res.status(400).json({ error: msg });
  }

  // Create the gym with a 30-day trial
  const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: gym, error: gymErr } = await admin
    .from('gyms')
    .insert({ name: gymName.trim(), room_code: roomCode, subscription_status: 'trial', trial_ends_at: trialEnd, referred_by: referredBy?.trim() || null })
    .select()
    .single();

  if (gymErr) {
    await admin.auth.admin.deleteUser(linkData.user.id);
    return res.status(500).json({ error: gymErr.message });
  }

  // Assign owner role in gym_users
  const { error: assignErr } = await admin
    .from('gym_users')
    .insert({ user_id: linkData.user.id, gym_id: gym.id, role: 'owner', email, name: name.trim() });

  if (assignErr) {
    await admin.auth.admin.deleteUser(linkData.user.id);
    await admin.from('gyms').delete().eq('id', gym.id);
    return res.status(500).json({ error: assignErr.message });
  }

  return res.status(200).json({ ok: true });
};
