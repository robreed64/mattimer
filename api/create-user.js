const { SITE_URL } = require('./_lib/supabase');
const { applyCors } = require('./_lib/cors');
const { requireCaller, isOwnerOfGym } = require('./_lib/auth');

const DEFAULT_INVITE_ROLE = 'coach';

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, gymId } = req.body;
  if (!email || !gymId) {
    return res.status(400).json({ error: 'email and gymId are required' });
  }

  const auth = await requireCaller(req, res);
  if (!auth) return;
  const { admin, caller, isAdmin } = auth;

  // Gym owners can invite anyone to their gym
  if (!isAdmin && !(await isOwnerOfGym(admin, caller.id, gymId))) {
    return res.status(403).json({ error: 'You are not an owner of that gym' });
  }

  // Generate invite link (Supabase sends the email automatically)
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: SITE_URL },
  });
  if (linkErr) return res.status(400).json({ error: linkErr.message });

  const userId = linkData.user.id;

  const { error: assignErr } = await admin
    .from('gym_users')
    .insert({ user_id: userId, gym_id: gymId, role: DEFAULT_INVITE_ROLE, email, name: name || null });

  if (assignErr) {
    await admin.auth.admin.deleteUser(userId);
    return res.status(500).json({ error: assignErr.message });
  }

  return res.status(200).json({
    ok: true,
    userId,
    inviteLink: linkData.properties.action_link,
  });
};
