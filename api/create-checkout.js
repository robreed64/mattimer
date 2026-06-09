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
  let gymId, gymDisplayName, customerId;

  if (isAdmin) {
    const { roomId: bodyRoomId } = req.body || {};
    if (!bodyRoomId) return res.status(400).json({ error: 'roomId required' });
    const { data: gym } = await admin.from('gyms').select('id, name, stripe_customer_id').eq('room_code', bodyRoomId).single();
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    gymId = gym.id;
    gymDisplayName = gym.name;
    customerId = gym.stripe_customer_id;
  } else {
    const { data: membership } = await admin
      .from('gym_users')
      .select('gym_id, role, gyms(id, name, stripe_customer_id)')
      .eq('user_id', caller.id)
      .single();
    if (!membership || membership.role !== 'owner') {
      return res.status(403).json({ error: 'Only gym owners can manage billing' });
    }
    gymId = membership.gym_id;
    gymDisplayName = membership.gyms.name;
    customerId = membership.gyms.stripe_customer_id;
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: caller.email,
      name: gymDisplayName || caller.email,
      metadata: { gym_id: gymId },
    });
    customerId = customer.id;
    await admin.from('gyms').update({ stripe_customer_id: customerId }).eq('id', gymId);
  }

  const { roomId } = req.body || {};
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${SITE_URL}${roomId ? `?room=${roomId}` : ''}#checkout=success`,
    cancel_url:  `${SITE_URL}${roomId ? `?room=${roomId}` : ''}`,
    subscription_data: { metadata: { gym_id: gymId } },
  });

  return res.status(200).json({ url: session.url });
};
