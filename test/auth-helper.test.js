const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireCaller, resolveOwnedGym, isOwnerOfGym } = require('../api/_lib/auth');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {},
    end() {},
  };
}

// Minimal fake of the supabase-js fluent query API. `rows` maps table name
// to the row returned by .single() (or null).
function fakeAdmin({ user, authError, rows = {} } = {}) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: authError || null }) },
    from(table) {
      const result = rows[table] ?? null;
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        single: async () => ({ data: result, error: result ? null : { message: 'not found' } }),
      };
      return chain;
    },
  };
}

test('requireCaller: missing Authorization header → 401', async () => {
  const res = makeRes();
  const out = await requireCaller({ headers: {} }, res, fakeAdmin());
  assert.equal(out, null);
  assert.equal(res.statusCode, 401);
});

test('requireCaller: invalid session → 401', async () => {
  const res = makeRes();
  const admin = fakeAdmin({ user: null, authError: { message: 'bad jwt' } });
  const out = await requireCaller({ headers: { authorization: 'Bearer xyz' } }, res, admin);
  assert.equal(out, null);
  assert.equal(res.statusCode, 401);
});

test('requireCaller: valid session returns caller and admin flag', async () => {
  const res = makeRes();
  const admin = fakeAdmin({ user: { id: 'u1', app_metadata: { role: 'admin' } } });
  const out = await requireCaller({ headers: { authorization: 'Bearer xyz' } }, res, admin);
  assert.equal(out.caller.id, 'u1');
  assert.equal(out.isAdmin, true);
});

test('resolveOwnedGym: platform admin without roomId → 400', async () => {
  const res = makeRes();
  const admin = fakeAdmin({});
  const out = await resolveOwnedGym({ admin, caller: { id: 'u1' }, isAdmin: true }, res, undefined);
  assert.equal(out, null);
  assert.equal(res.statusCode, 400);
});

test('resolveOwnedGym: platform admin resolves gym by room code', async () => {
  const res = makeRes();
  const admin = fakeAdmin({ rows: { gyms: { id: 'g1' } } });
  const out = await resolveOwnedGym({ admin, caller: { id: 'u1' }, isAdmin: true }, res, 'ABC123');
  assert.equal(out.id, 'g1');
});

test('resolveOwnedGym: coach is forbidden', async () => {
  const res = makeRes();
  const admin = fakeAdmin({ rows: { gym_users: { gym_id: 'g1', role: 'coach' } } });
  const out = await resolveOwnedGym({ admin, caller: { id: 'u1' }, isAdmin: false }, res, undefined, {
    forbiddenMsg: 'Only gym owners can manage rooms',
  });
  assert.equal(out, null);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Only gym owners can manage rooms');
});

test('resolveOwnedGym: owner resolves own gym', async () => {
  const res = makeRes();
  const admin = fakeAdmin({ rows: { gym_users: { gym_id: 'g1', role: 'owner' }, gyms: { id: 'g1' } } });
  const out = await resolveOwnedGym({ admin, caller: { id: 'u1' }, isAdmin: false }, res, undefined);
  assert.equal(out.id, 'g1');
});

test('isOwnerOfGym distinguishes owner from coach', async () => {
  assert.equal(await isOwnerOfGym(fakeAdmin({ rows: { gym_users: { role: 'owner' } } }), 'u1', 'g1'), true);
  assert.equal(await isOwnerOfGym(fakeAdmin({ rows: { gym_users: { role: 'coach' } } }), 'u1', 'g1'), false);
  assert.equal(await isOwnerOfGym(fakeAdmin({}), 'u1', 'g1'), false);
});
