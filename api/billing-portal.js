const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL     = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'https://bjj-timer-gamma.vercel.app';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!callerJwt) return res.status(401).json({ error: 'Not authenticated' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user: caller }, error: authErr } = await admin.auth.getUser(callerJwt);
  if (authErr || !caller) return res.status(401).json({ error: 'Invalid session' });

  const isAdmin = caller.app_metadata?.role === 'admin';
  let customerId;

  if (isAdmin) {
    const { roomId } = req.body || {};
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const { data: gym } = await admin.from('gyms').select('stripe_customer_id').eq('room_code', roomId).single();
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    customerId = gym.stripe_customer_id;
  } else {
    const { data: membership, error: memErr } = await admin
      .from('gym_users')
      .select('gym_id, role')
      .eq('user_id', caller.id)
      .single();
    if (memErr || !membership || membership.role !== 'owner') {
      return res.status(403).json({ error: 'Only gym owners can manage billing', detail: memErr?.message });
    }
    const { data: gym } = await admin.from('gyms').select('stripe_customer_id').eq('id', membership.gym_id).single();
    customerId = gym?.stripe_customer_id;
  }
  if (!customerId) {
    return res.status(400).json({ error: 'No billing account found. Start a subscription first.' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: SITE_URL,
  });

  return res.status(200).json({ url: session.url });
};
