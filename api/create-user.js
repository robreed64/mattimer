const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY   = process.env.SUPABASE_PUBLISHABLE_KEY;
const SITE_URL          = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'https://bjj-timer-gamma.vercel.app';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, gymId, role } = req.body;
  if (!email || !gymId || !role) {
    return res.status(400).json({ error: 'email, gymId, and role are required' });
  }
  if (!['owner', 'coach'].includes(role)) {
    return res.status(400).json({ error: 'role must be owner or coach' });
  }

  // Verify the calling user's JWT
  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!callerJwt) return res.status(401).json({ error: 'Not authenticated' });

  const callerClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
  });
  const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
  if (authErr || !caller) return res.status(401).json({ error: 'Invalid session' });

  const isAdmin = caller.app_metadata?.role === 'admin';
  if (!isAdmin) {
    if (role !== 'coach') return res.status(403).json({ error: 'Only admins can create owners' });
    const { data: membership } = await callerClient
      .from('gym_users')
      .select('role')
      .eq('gym_id', gymId)
      .eq('user_id', caller.id)
      .single();
    if (!membership || membership.role !== 'owner') {
      return res.status(403).json({ error: 'You are not an owner of that gym' });
    }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Generate an invite link — returns a token the user clicks to set their password
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: SITE_URL },
  });
  if (linkErr) return res.status(400).json({ error: linkErr.message });

  const userId = linkData.user.id;

  // Assign user to gym
  const { error: assignErr } = await admin
    .from('gym_users')
    .insert({ user_id: userId, gym_id: gymId, role });

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
