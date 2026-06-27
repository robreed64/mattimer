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

  const result = await applySubscriptionEvent(adminClient(), event);
  // A DB write that failed must NOT be reported as success, or Stripe stops
  // retrying and the gym's subscription state is silently left wrong. Return 500
  // so Stripe re-delivers. Handlers are idempotent (absolute writes keyed by
  // customer), so re-delivery is safe.
  if (!result.ok) {
    return Response.json({ error: 'processing failed' }, { status: 500 });
  }
  return Response.json({ received: true });
}

// Apply a Stripe subscription event to the gyms table. Returns { ok } — ok:false
// means a DB error (caller should 500 so Stripe retries). An event that matches
// no gym, or a type we don't handle, is ok:true (retrying wouldn't help). admin
// is injected so this is unit-testable without a live Supabase.
export async function applySubscriptionEvent(admin, event) {
  const updateGym = async (fields, customer) => {
    const { data, error } = await admin.from('gyms')
      .update(fields)
      .eq('stripe_customer_id', customer)
      .select();
    if (error) {
      console.error(`[stripe-webhook] ${event.type} (${event.id}) DB error for ${customer}: ${error.message}`);
      return { ok: false };
    }
    if (!data || data.length === 0) {
      console.warn(`[stripe-webhook] ${event.type} (${event.id}) matched no gym for customer ${customer}`);
    }
    return { ok: true };
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') return { ok: true };
      return updateGym(
        { stripe_subscription_id: session.subscription, subscription_status: 'active' },
        session.customer,
      );
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      return updateGym({ subscription_status: sub.status }, sub.customer);
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      return updateGym({ subscription_status: 'canceled', stripe_subscription_id: null }, sub.customer);
    }
    default:
      return { ok: true };
  }
}
