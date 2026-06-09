const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];

  // Vercel's Node.js runtime auto-parses JSON bodies. Stripe signature
  // verification needs the exact raw bytes. Re-serializing the parsed body
  // works because Stripe sends compact JSON (no extra whitespace).
  const rawBody = typeof req.body === 'string'
    ? req.body
    : JSON.stringify(req.body);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook verification failed: ' + err.message });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.mode === 'subscription') {
      await admin.from('gyms')
        .update({ stripe_subscription_id: session.subscription, subscription_status: 'active' })
        .eq('stripe_customer_id', session.customer);
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    await admin.from('gyms')
      .update({ subscription_status: sub.status })
      .eq('stripe_customer_id', sub.customer);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await admin.from('gyms')
      .update({ subscription_status: 'canceled', stripe_subscription_id: null })
      .eq('stripe_customer_id', sub.customer);
  }

  return res.status(200).json({ received: true });
};
