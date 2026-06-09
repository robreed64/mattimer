const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SERVICE_KEY          = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_INVITE_ROLE  = 'coach';
const SITE_URL             = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'https://bjj-timer-gamma.vercel.app';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, gymId } = req.body;
  if (!email || !gymId) {
    return res.status(400).json({ error: 'email and gymId are required' });
  }

  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!callerJwt) return res.status(401).json({ error: 'Not authenticated' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify caller JWT via admin client
  const { data: { user: caller }, error: authErr } = await admin.auth.getUser(callerJwt);
  if (authErr || !caller) return res.status(401).json({ error: 'Invalid session: ' + (authErr?.message || 'no user') });

  const isAdmin = caller.app_metadata?.role === 'admin';
  if (!isAdmin) {
    // Gym owners can invite anyone to their gym
    const { data: membership } = await admin
      .from('gym_users')
      .select('role')
      .eq('gym_id', gymId)
      .eq('user_id', caller.id)
      .single();
    if (!membership || membership.role !== 'owner') {
      return res.status(403).json({ error: 'You are not an owner of that gym' });
    }
  }

  // Generate invite link
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
