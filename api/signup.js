const { makeCode } = require('../lib/room-code');
const { adminClient, SITE_URL } = require('./_lib/supabase');
const { applyCors } = require('./_lib/cors');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, gymName, email } = req.body || {};
  if (!name?.trim() || !gymName?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Your name, gym name, and email are all required.' });
  }

  const admin = adminClient();

  // Generate a unique room code (collisions are astronomically rare but handle them)
  let roomCode;
  for (let i = 0; i < 10; i++) {
    const candidate = makeCode();
    const { data: clash } = await admin.from('gyms').select('id').eq('room_code', candidate).single();
    if (!clash) { roomCode = candidate; break; }
  }
  if (!roomCode) return res.status(500).json({ error: 'Could not generate a room code. Please try again.' });

  // Create the gym with a 30-day trial
  const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: gym, error: gymErr } = await admin
    .from('gyms')
    .insert({ name: gymName.trim(), room_code: roomCode, subscription_status: 'trial', trial_ends_at: trialEnd })
    .select()
    .single();

  if (gymErr) return res.status(500).json({ error: gymErr.message });

  // Create user + send invite email (Supabase sends the email automatically)
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email: email.trim(),
    options: { redirectTo: `${SITE_URL}?room=${roomCode}` },
  });

  if (linkErr) {
    await admin.from('gyms').delete().eq('id', gym.id);
    const msg = linkErr.message?.toLowerCase().includes('already')
      ? 'An account with that email already exists. Try signing in instead.'
      : linkErr.message;
    return res.status(400).json({ error: msg });
  }

  // Assign owner role in gym_users
  const { error: assignErr } = await admin
    .from('gym_users')
    .insert({ user_id: linkData.user.id, gym_id: gym.id, role: 'owner', email: email.trim(), name: name.trim() });

  if (assignErr) {
    await admin.auth.admin.deleteUser(linkData.user.id);
    await admin.from('gyms').delete().eq('id', gym.id);
    return res.status(500).json({ error: assignErr.message });
  }

  return res.status(200).json({ ok: true });
};
