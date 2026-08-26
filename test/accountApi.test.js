// Mocked-DB unit tests for src/functions/account/*.js (GET /api/account/me, /appointments,
// /billing). Same require-cache-substitution approach as test/adminApi.test.js uses for `pg`. The
// key thing under test in every one of these: the customer_id used to scope the SQL query always
// comes from the verified session cookie (via lib/customerAuth.js's requireCustomer, exercised for
// real here) — never from anything client-supplied — and every handler 401s cleanly with no cookie.
//
// Run with: node test/accountApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const ACCOUNT_DIR = path.join(__dirname, '..', 'src', 'functions', 'account');
const ME_PATH = path.join(ACCOUNT_DIR, 'me.js');
const APPOINTMENTS_PATH = path.join(ACCOUNT_DIR, 'appointments.js');
const BILLING_PATH = path.join(ACCOUNT_DIR, 'billing.js');

const { signCustomerSession, SESSION_COOKIE_NAME } = require('../lib/customerAuth');

function makeFakePool(queryImpl) {
  const calls = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      calls.push({ sql, params });
      return queryImpl(sql, params, calls.length - 1);
    }
  }
  return { FakePool, calls };
}

function loadHandlerWithMockedPg(modulePath, queryImpl) {
  const { FakePool, calls } = makeFakePool(queryImpl);
  delete require.cache[PG_PATH];
  delete require.cache[modulePath];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(modulePath);
  delete require.cache[PG_PATH];
  delete require.cache[modulePath];
  return { mod, calls };
}

function fakeRequest({ cookie } = {}) {
  return {
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : null) },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
}

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-secret';
  const COOKIE_FOR = (customerId) => `${SESSION_COOKIE_NAME}=${signCustomerSession(customerId, 'test-customer-secret')}`;

  // ---------------- /api/account/me ----------------

  await test('me: 401 with no session cookie', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async () => ({ rows: [] }));
    const res = await mod.accountMeHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('me: 200 with the customer scoped to the session, queried by the session\'s customerId, and a computed customer number', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{ id: params[0], name: 'Jamie', email: 'jamie@example.com', phone: null, created_at: 'now' }],
    }));
    const res = await mod.accountMeHandler(fakeRequest({ cookie: COOKIE_FOR(42) }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.id, 42);
    assert.strictEqual(res.jsonBody.customer.number, 'AFD-000042');
    assert.deepStrictEqual(calls[0].params, [42]);
  });

  await test('me: 200 reissues a fresh session cookie (sliding "remember me" refresh) for the same customer', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{ id: params[0], name: 'Jamie', email: 'jamie@example.com', phone: null, created_at: 'now' }],
    }));
    const res = await mod.accountMeHandler(fakeRequest({ cookie: COOKIE_FOR(42) }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.cookies) && res.cookies.length === 1, 'expected exactly one reissued cookie');
    const cookie = res.cookies[0];
    assert.strictEqual(cookie.name, SESSION_COOKIE_NAME);
    assert.strictEqual(cookie.httpOnly, true);
    assert.strictEqual(cookie.secure, true);
    assert.strictEqual(cookie.sameSite, 'Strict');
    // 90 days, not just "extended a bit" — see lib/customerAuth.js's SESSION_TTL_MS comment.
    assert.strictEqual(cookie.maxAge, 90 * 24 * 60 * 60);
    const { verifyCustomerSession } = require('../lib/customerAuth');
    const verified = verifyCustomerSession(cookie.value, 'test-customer-secret');
    assert.ok(verified, 'the reissued cookie must itself verify as a valid session');
    assert.strictEqual(verified.customerId, 42, 'the reissued cookie must be for the SAME customer, never a different one');
  });

  await test('me: 401 if the session verifies but the customer row is gone', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async () => ({ rows: [] }));
    const res = await mod.accountMeHandler(fakeRequest({ cookie: COOKIE_FOR(999) }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  // ---------------- PATCH /api/account/me (name-collection step for a brand-new signup) ----------------

  await test('me update: 401 with no session cookie', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async () => ({ rows: [] }));
    const res = await mod.accountMeUpdateHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('me update: 400 when name is missing/blank', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async () => ({ rows: [] }));
    const res = await mod.accountMeUpdateHandler(
      { ...fakeRequest({ cookie: COOKIE_FOR(5) }), json: async () => ({ name: '   ' }) },
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('me update: 200, updates the session\'s own customer row and returns it with a computed number', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{ id: params[1], name: params[0], email: 'jamie@example.com', phone: null, created_at: 'now' }],
    }));
    const res = await mod.accountMeUpdateHandler(
      { ...fakeRequest({ cookie: COOKIE_FOR(7) }), json: async () => ({ name: '  Jamie Rivera  ' }) },
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.name, 'Jamie Rivera'); // trimmed
    assert.strictEqual(res.jsonBody.customer.number, 'AFD-000007');
    assert.ok(/UPDATE customers SET name/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['Jamie Rivera', 7]); // scoped to the session's own customerId
  });

  // ---------------- PATCH /api/account/me (self-editable hair profile: hair_type, hair_texture,
  // allergies, preferences — same four customers columns admin/clients.js's staff-side Clients tab
  // reads/writes, mirrored partial-patch/trim/clear semantics) ----------------

  await test('me update: 401 with no session cookie (profile-only patch)', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async () => ({ rows: [] }));
    const res = await mod.accountMeUpdateHandler(
      { ...fakeRequest({}), json: async () => ({ hair_type: 'natural' }) },
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('me update: 400 when body has none of the recognized fields (name or profile fields)', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async () => ({ rows: [] }));
    const res = await mod.accountMeUpdateHandler(
      { ...fakeRequest({ cookie: COOKIE_FOR(5) }), json: async () => ({ unrelated: 'x' }) },
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('me update: 200, a partial patch on one profile field only sets that column, scoped to the session\'s own id', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{
        id: params[1], name: 'Jamie', email: 'jamie@example.com', phone: null,
        hair_type: params[0], hair_texture: null, allergies: null, preferences: null, created_at: 'now',
      }],
    }));
    const res = await mod.accountMeUpdateHandler(
      { ...fakeRequest({ cookie: COOKIE_FOR(9) }), json: async () => ({ hair_type: '  natural  ' }) },
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.hair_type, 'natural'); // trimmed
    assert.ok(/UPDATE customers SET hair_type = \$1 WHERE id = \$2/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['natural', 9]); // scoped to the session's own customerId, not clobbering other fields
  });

  await test('me update: an explicit null clears one profile field without touching the others (partial patch doesn\'t clobber)', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(ME_PATH, async () => ({
      rows: [{ id: 9, name: 'Jamie', email: 'jamie@example.com', phone: null, hair_type: 'natural', hair_texture: null, allergies: null, preferences: 'low heat', created_at: 'now' }],
    }));
    const res = await mod.accountMeUpdateHandler(
      { ...fakeRequest({ cookie: COOKIE_FOR(9) }), json: async () => ({ allergies: null }) },
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.ok(/SET allergies = \$1 WHERE/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, [null, 9]); // only allergies touched, hair_type/preferences untouched by this query
  });

  await test('me update: combining a name update with profile-field updates in one PATCH works, still scoped to the session id', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{
        id: params[3], name: params[0], email: 'jamie@example.com', phone: null,
        hair_type: params[1], hair_texture: null, allergies: null, preferences: params[2], created_at: 'now',
      }],
    }));
    const res = await mod.accountMeUpdateHandler(
      {
        ...fakeRequest({ cookie: COOKIE_FOR(11) }),
        json: async () => ({ name: 'Jamie R', hair_type: 'locs', preferences: 'low heat' }),
      },
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.name, 'Jamie R');
    assert.strictEqual(res.jsonBody.customer.hair_type, 'locs');
    assert.strictEqual(res.jsonBody.customer.preferences, 'low heat');
    assert.ok(/SET name = \$1, hair_type = \$2, preferences = \$3 WHERE id = \$4/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['Jamie R', 'locs', 'low heat', 11]);
  });

  await test('me update: a body-supplied id/customerId is ignored — only the session\'s own customerId is ever used to scope the WHERE', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{ id: params[1], name: 'Jamie', email: 'jamie@example.com', phone: null, hair_type: params[0], hair_texture: null, allergies: null, preferences: null, created_at: 'now' }],
    }));
    const res = await mod.accountMeUpdateHandler(
      {
        ...fakeRequest({ cookie: COOKIE_FOR(13) }),
        json: async () => ({ hair_type: 'kinky', id: 9999, customerId: 9999, customer_id: 9999 }),
      },
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    // id/customerId/customer_id in the body are simply not among the recognized fields (name + the
    // four PROFILE_FIELDS), so they never reach the query — the WHERE clause's only id comes from
    // auth.customerId (13, from the verified session cookie), never from the request body.
    assert.deepStrictEqual(calls[0].params, ['kinky', 13]);
  });

  await test('me: GET round-trips profile fields written by a prior PATCH, for the same session\'s customerId both times', async () => {
    const stored = { hair_type: null, hair_texture: null, allergies: null, preferences: null };
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => {
      if (/^UPDATE customers/.test(sql)) {
        stored.hair_type = params[0];
        return { rows: [{ id: params[1], name: 'Jamie', email: 'jamie@example.com', phone: null, ...stored, created_at: 'now' }] };
      }
      // GET /api/account/me
      return { rows: [{ id: params[0], name: 'Jamie', email: 'jamie@example.com', phone: null, ...stored, created_at: 'now' }] };
    });
    const patchRes = await mod.accountMeUpdateHandler(
      { ...fakeRequest({ cookie: COOKIE_FOR(21) }), json: async () => ({ hair_type: 'natural' }) },
      fakeContext()
    );
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.jsonBody.customer.hair_type, 'natural');

    const getRes = await mod.accountMeHandler(fakeRequest({ cookie: COOKIE_FOR(21) }), fakeContext());
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.jsonBody.customer.hair_type, 'natural'); // round-tripped
  });

  await test('me: GET also returns hair_type/hair_texture/allergies/preferences alongside the existing fields', async () => {
    const { mod } = loadHandlerWithMockedPg(ME_PATH, async (sql, params) => ({
      rows: [{
        id: params[0], name: 'Jamie', email: 'jamie@example.com', phone: null,
        hair_type: 'natural', hair_texture: '4c', allergies: 'sulfates', preferences: 'low heat',
        created_at: 'now',
      }],
    }));
    const res = await mod.accountMeHandler(fakeRequest({ cookie: COOKIE_FOR(30) }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.hair_type, 'natural');
    assert.strictEqual(res.jsonBody.customer.hair_texture, '4c');
    assert.strictEqual(res.jsonBody.customer.allergies, 'sulfates');
    assert.strictEqual(res.jsonBody.customer.preferences, 'low heat');
  });

  // ---------------- /api/account/appointments ----------------

  await test('appointments: 401 with no session cookie', async () => {
    const { mod } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: [] }));
    const res = await mod.accountAppointmentsHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('appointments: 200, scopes the query to WHERE a.customer_id = <session customerId>', async () => {
    const fakeRows = [{ id: 1, service_name: 'Braids', start_at: '2026-09-01T14:00:00.000Z', status: 'confirmed' }];
    const { mod, calls } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: fakeRows }));
    const res = await mod.accountAppointmentsHandler(fakeRequest({ cookie: COOKIE_FOR(7) }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.appointments, fakeRows);
    assert.deepStrictEqual(calls[0].params, [7]);
    assert.ok(/customer_id = \$1/.test(calls[0].sql));
  });

  // ---------------- /api/account/billing ----------------

  await test('billing: 401 with no session cookie', async () => {
    const { mod } = loadHandlerWithMockedPg(BILLING_PATH, async () => ({ rows: [] }));
    const res = await mod.accountBillingHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('billing: 200, scopes to the session\'s customer_id and sums totalCents correctly', async () => {
    const fakeRows = [
      { id: 1, amount_cents: 2000, method: 'cash_app', note: 'deposit', created_at: 'a' },
      { id: 2, amount_cents: 3500, method: 'zelle', note: null, created_at: 'b' },
    ];
    const { mod, calls } = loadHandlerWithMockedPg(BILLING_PATH, async () => ({ rows: fakeRows }));
    const res = await mod.accountBillingHandler(fakeRequest({ cookie: COOKIE_FOR(3) }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.totalCents, 5500);
    assert.deepStrictEqual(calls[0].params, [3]);
    assert.ok(/b\.customer_id = \$1/.test(calls[0].sql));
  });

  await test('billing: 200 with an empty ledger sums to totalCents 0', async () => {
    const { mod } = loadHandlerWithMockedPg(BILLING_PATH, async () => ({ rows: [] }));
    const res = await mod.accountBillingHandler(fakeRequest({ cookie: COOKIE_FOR(3) }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.totalCents, 0);
    assert.deepStrictEqual(res.jsonBody.entries, []);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
