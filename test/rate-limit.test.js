const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkSignupRate, PER_IP_MAX, GLOBAL_MAX } = require('../api/_lib/rate-limit');

// Fake of the supabase fluent API as used by checkSignupRate: the .gte()
// call is the awaitable terminal for both count queries; .eq() marks the
// per-IP query so the fake can return the right count.
function fakeAdmin({ ipCount = 0, allCount = 0, error = null } = {}) {
  const inserts = [];
  const admin = {
    inserts,
    from() {
      let perIp = false;
      const chain = {
        select() { return chain; },
        eq() { perIp = true; return chain; },
        gte() {
          if (error) return Promise.resolve({ count: null, error });
          return Promise.resolve({ count: perIp ? ipCount : allCount, error: null });
        },
        insert(row) { inserts.push(row); return Promise.resolve({ error: null }); },
        delete() { return { lt: () => Promise.resolve({ error: null }) }; },
      };
      return chain;
    },
  };
  return admin;
}

test('allows under both limits and records the attempt', async () => {
  const admin = fakeAdmin({ ipCount: 0, allCount: 0 });
  const { allowed } = await checkSignupRate(admin, '1.2.3.4');
  assert.equal(allowed, true);
  assert.deepEqual(admin.inserts, [{ ip: '1.2.3.4' }]);
});

test('denies at the per-IP limit without recording', async () => {
  const admin = fakeAdmin({ ipCount: PER_IP_MAX });
  const { allowed } = await checkSignupRate(admin, '1.2.3.4');
  assert.equal(allowed, false);
  assert.equal(admin.inserts.length, 0);
});

test('denies at the global limit even for a fresh IP', async () => {
  const admin = fakeAdmin({ ipCount: 0, allCount: GLOBAL_MAX });
  const { allowed } = await checkSignupRate(admin, '5.6.7.8');
  assert.equal(allowed, false);
  assert.equal(admin.inserts.length, 0);
});

test('fails open when the store errors', async () => {
  const admin = fakeAdmin({ error: { message: 'connection refused' } });
  const { allowed } = await checkSignupRate(admin, '1.2.3.4');
  assert.equal(allowed, true);
});
