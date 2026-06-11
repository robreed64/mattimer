const { test, before } = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-dummy';

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

let POST;
before(async () => {
  ({ POST } = await import('../api/stripe-webhook.mjs'));
});

// An event type the handler ignores, so no Supabase calls are made.
const payload = JSON.stringify({
  id: 'evt_test_1',
  object: 'event',
  type: 'invoice.paid',
  data: { object: {} },
});

function webhookRequest(body, signature) {
  return new Request('https://example.com/api/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
    body,
  });
}

test('accepts a correctly signed event', async () => {
  const sig = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  const res = await POST(webhookRequest(payload, sig));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
});

test('rejects a tampered body', async () => {
  const sig = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  const tampered = payload.replace('invoice.paid', 'invoice.void');
  const res = await POST(webhookRequest(tampered, sig));
  assert.equal(res.status, 400);
});

test('rejects a wrong webhook secret', async () => {
  const sig = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_wrong',
  });
  const res = await POST(webhookRequest(payload, sig));
  assert.equal(res.status, 400);
});

test('rejects a missing signature header', async () => {
  const res = await POST(new Request('https://example.com/api/stripe-webhook', {
    method: 'POST',
    body: payload,
  }));
  assert.equal(res.status, 400);
});
