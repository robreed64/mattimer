// Web-standard handler (named POST export) so we get the exact raw request
// bytes for Stripe signature verification — the old (req, res) Node handler
// only saw Vercel's pre-parsed JSON body and had to re-serialize it.
import Stripe from 'stripe';
import { adminClient } from './_lib/supabase.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return Response.json({ error: 'Webhook verification failed: ' + err.message }, { status: 400 });
  }

  const admin = adminClient();

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

  return Response.json({ received: true });
}
