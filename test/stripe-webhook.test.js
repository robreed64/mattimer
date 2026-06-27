const { test, before } = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-dummy';

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

let POST, applySubscriptionEvent;
before(async () => {
  ({ POST, applySubscriptionEvent } = await import('../api/stripe-webhook.mjs'));
});

// A fake Supabase admin client whose update→eq→select chain resolves to the
// given { data, error }. Records the table and fields written for assertions.
function fakeAdmin(result) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        update(fields) {
          calls.push({ table, fields });
          return { eq() { return { select: async () => result }; } };
        },
      };
    },
  };
}

const subEvent = (overrides = {}) => ({
  id: 'evt_1',
  type: 'customer.subscription.updated',
  data: { object: { customer: 'cus_1', status: 'active' } },
  ...overrides,
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

// ─── applySubscriptionEvent: money-path error handling ───────────────

test('successful subscription update returns ok', async () => {
  const admin = fakeAdmin({ data: [{ id: 'gym_1' }], error: null });
  const result = await applySubscriptionEvent(admin, subEvent());
  assert.equal(result.ok, true);
  assert.deepEqual(admin.calls[0], { table: 'gyms', fields: { subscription_status: 'active' } });
});

test('a Supabase error is NOT swallowed — returns not ok (so Stripe retries)', async () => {
  const admin = fakeAdmin({ data: null, error: { message: 'db down' } });
  const result = await applySubscriptionEvent(admin, subEvent());
  assert.equal(result.ok, false);
});

test('an unmatched customer (0 rows) returns ok (no pointless Stripe retries)', async () => {
  const admin = fakeAdmin({ data: [], error: null });
  const result = await applySubscriptionEvent(admin, subEvent());
  assert.equal(result.ok, true);
});

test('checkout.session.completed (subscription) activates the gym', async () => {
  const admin = fakeAdmin({ data: [{ id: 'gym_1' }], error: null });
  const event = { id: 'evt_2', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', subscription: 'sub_9', customer: 'cus_1' } } };
  const result = await applySubscriptionEvent(admin, event);
  assert.equal(result.ok, true);
  assert.deepEqual(admin.calls[0].fields, { stripe_subscription_id: 'sub_9', subscription_status: 'active' });
});

test('subscription.deleted cancels and clears the subscription id', async () => {
  const admin = fakeAdmin({ data: [{ id: 'gym_1' }], error: null });
  const event = subEvent({ type: 'customer.subscription.deleted',
    data: { object: { customer: 'cus_1', status: 'canceled' } } });
  const result = await applySubscriptionEvent(admin, event);
  assert.equal(result.ok, true);
  assert.deepEqual(admin.calls[0].fields, { subscription_status: 'canceled', stripe_subscription_id: null });
});

test('an ignored event type touches no DB and returns ok', async () => {
  const admin = fakeAdmin({ data: null, error: { message: 'should not be called' } });
  const result = await applySubscriptionEvent(admin, subEvent({ type: 'invoice.paid', data: { object: {} } }));
  assert.equal(result.ok, true);
  assert.equal(admin.calls.length, 0);
});
