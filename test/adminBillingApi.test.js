// Mocked-DB unit tests for src/functions/admin/billing.js (GET/POST /api/staffconsole/appointments/:id/billing).
// Same require-cache-substitution approach as test/adminApi.test.js, and reuses its `signSession`/
// requireAdmin machinery for real (lib/adminAuth.js is pure crypto, not mocked).
//
// Run with: node test/adminBillingApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const STRIPE_LIB_PATH = path.join(__dirname, '..', 'lib', 'stripe.js');
const BILLING_PATH = path.join(__dirname, '..', 'src', 'functions', 'admin', 'billing.js');

const { signSession, SESSION_COOKIE_NAME } = require('../lib/adminAuth');

// requireAdmin() now looks up admin_account's current session_epoch on every call (see
// lib/adminAuth.js's header comment / db/schema.sql's admin_account.session_epoch comment) --
// answered here from a fixed epoch of 1 (matching signSession(secret, 1) below) so none of this
// file's existing tests need to know that query exists. It's intercepted before reaching the test's
// own queryImpl / `calls`, same approach as test/adminApi.test.js's makeFakePool.
function makeFakePool(queryImpl) {
  const calls = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      if (/^SELECT session_epoch FROM admin_account WHERE id = 1$/.test(sql)) {
        return { rows: [{ session_epoch: 1 }] };
      }
      calls.push({ sql, params });
      return queryImpl(sql, params, calls.length - 1);
    }
  }
  return { FakePool, calls };
}

// `stripeMock`, when passed, substitutes lib/stripe.js the same require-cache way as `pg` -- used
// only by the pay-link tests below. Left undefined, billing.js requires the real lib/stripe.js (safe
// for the existing list/create tests: nothing in this file touches a Stripe network call at require
// time, isConfigured()/createPaymentLink() are only ever invoked from adminBillingPayLinkHandler).
function loadHandlerWithMockedPg(queryImpl, stripeMock) {
  const { FakePool, calls } = makeFakePool(queryImpl);
  delete require.cache[PG_PATH];
  delete require.cache[BILLING_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  if (stripeMock) {
    delete require.cache[STRIPE_LIB_PATH];
    const fakeStripeLib = new Module(STRIPE_LIB_PATH);
    fakeStripeLib.exports = stripeMock;
    fakeStripeLib.loaded = true;
    require.cache[STRIPE_LIB_PATH] = fakeStripeLib;
  }

  const mod = require(BILLING_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[BILLING_PATH];
  if (stripeMock) delete require.cache[STRIPE_LIB_PATH];
  return { mod, calls };
}

function fakeRequest({ body, params, cookie } = {}) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    params: params || {},
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

  process.env.ADMIN_SESSION_SECRET = 'test-secret';
  const COOKIE = `${SESSION_COOKIE_NAME}=${signSession('test-secret', 1)}`;

  // ---------------- list ----------------

  await test('list: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminBillingListHandler(fakeRequest({ params: { id: '5' } }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('list: 400 on a non-integer id', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminBillingListHandler(fakeRequest({ cookie: COOKIE, params: { id: 'abc' } }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  await test('list: 200 returns entries for that appointment', async () => {
    const rows = [{ id: 1, appointment_id: 5, amount_cents: 2000, method: 'cash_app', note: null }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminBillingListHandler(fakeRequest({ cookie: COOKIE, params: { id: '5' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.entries, rows);
    assert.deepStrictEqual(calls[0].params, ['5']);
  });

  // ---------------- create ----------------

  await test('create: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminBillingCreateHandler(
      fakeRequest({ params: { id: '5' }, body: { amountCents: 2000, method: 'cash_app' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('create: 400 on invalid amount and invalid method', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const badAmount = await mod.adminBillingCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: -5, method: 'cash_app' } }),
      fakeContext()
    );
    assert.strictEqual(badAmount.status, 400);

    const badMethod = await mod.adminBillingCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: 2000, method: 'venmo' } }),
      fakeContext()
    );
    assert.strictEqual(badMethod.status, 400);

    const nonIntegerAmount = await mod.adminBillingCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: 20.5, method: 'cash' } }),
      fakeContext()
    );
    assert.strictEqual(nonIntegerAmount.status, 400);
  });

  await test('create: 404 when the appointment does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async (sql) => {
      if (/SELECT id, customer_id FROM appointments/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.adminBillingCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' }, body: { amountCents: 2000, method: 'cash_app' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('create: 201 inserts with the appointment\'s customer_id (nullable) and source=manual/recorded_by=admin', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async (sql, params) => {
      if (/SELECT id, customer_id FROM appointments/.test(sql)) return { rows: [{ id: 5, customer_id: 12 }] };
      if (/INSERT INTO billing_entries/.test(sql)) {
        return {
          rows: [{
            id: 1, appointment_id: params[0], customer_id: params[1], amount_cents: params[2],
            method: params[3], note: params[4], source: 'manual', recorded_by: 'admin', created_at: 'now',
          }],
        };
      }
      return { rows: [] };
    });
    const res = await mod.adminBillingCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: 2000, method: 'zelle', note: 'deposit' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.jsonBody.entry.customer_id, 12);
    assert.strictEqual(res.jsonBody.entry.source, 'manual');
    assert.strictEqual(res.jsonBody.entry.recorded_by, 'admin');
    const insertCall = calls.find((c) => /INSERT INTO billing_entries/.test(c.sql));
    assert.deepStrictEqual(insertCall.params, ['5', 12, 2000, 'zelle', 'deposit']);
  });

  await test('create: works for a guest (unlinked) appointment — customer_id stays null', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async (sql, params) => {
      if (/SELECT id, customer_id FROM appointments/.test(sql)) return { rows: [{ id: 6, customer_id: null }] };
      if (/INSERT INTO billing_entries/.test(sql)) {
        return { rows: [{ id: 2, appointment_id: params[0], customer_id: params[1], amount_cents: params[2], method: params[3], note: params[4] }] };
      }
      return { rows: [] };
    });
    const res = await mod.adminBillingCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '6' }, body: { amountCents: 2000, method: 'cash' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.jsonBody.entry.customer_id, null);
  });

  // ---------------- pay-link ----------------

  function stripeMock({ configured = true, createPaymentLinkImpl } = {}) {
    return {
      isConfigured: () => configured,
      createPaymentLink: createPaymentLinkImpl || (async () => { throw new Error('createPaymentLink should not be called'); }),
    };
  }

  await test('pay-link: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }), stripeMock());
    const res = await mod.adminBillingPayLinkHandler(
      fakeRequest({ params: { id: '5' }, body: { amountCents: 2000 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('pay-link: 400 on invalid/non-integer/negative amountCents', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }), stripeMock());

    const missing = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: {} }),
      fakeContext()
    );
    assert.strictEqual(missing.status, 400);

    const negative = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: -5 } }),
      fakeContext()
    );
    assert.strictEqual(negative.status, 400);

    const nonInteger = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: 20.5 } }),
      fakeContext()
    );
    assert.strictEqual(nonInteger.status, 400);
  });

  await test('pay-link: 503 when Stripe is not configured (and never queries the appointment)', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows: [] }), stripeMock({ configured: false }));
    const res = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: 2000 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.jsonBody.code, 'not_configured');
    assert.strictEqual(calls.length, 0);
  });

  await test('pay-link: 404 when the appointment does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async (sql) => {
      if (/SELECT id, customer_id, customer_name FROM appointments/.test(sql)) return { rows: [] };
      return { rows: [] };
    }, stripeMock());
    const res = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' }, body: { amountCents: 2000 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('pay-link: happy path returns {url}, passes the exact description/metadata shape, and never inserts billing_entries', async () => {
    let captured;
    const { mod, calls } = loadHandlerWithMockedPg(async (sql) => {
      if (/SELECT id, customer_id, customer_name FROM appointments/.test(sql)) {
        return { rows: [{ id: 5, customer_id: 12, customer_name: 'Jane Doe' }] };
      }
      return { rows: [] };
    }, stripeMock({
      createPaymentLinkImpl: async (params) => {
        captured = params;
        return { id: 'plink_123', url: 'https://buy.stripe.com/test_abc123' };
      },
    }));

    const res = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { amountCents: 4500 } }),
      fakeContext()
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody, { url: 'https://buy.stripe.com/test_abc123' });

    assert.strictEqual(captured.amountCents, 4500);
    assert.strictEqual(captured.currency, 'usd');
    assert.strictEqual(captured.description, 'AFRIKANADOLLZ balance — Jane Doe');
    assert.deepStrictEqual(captured.metadata, { purpose: 'admin_link', appointmentId: '5', customerId: '12' });

    const insertCall = calls.find((c) => /INSERT INTO billing_entries/.test(c.sql));
    assert.strictEqual(insertCall, undefined, 'pay-link endpoint must never insert a billing_entries row itself');
  });

  await test('pay-link: falls back to "appointment #<id>" in the description, and customerId:"" in metadata, for a guest (unlinked) appointment', async () => {
    let captured;
    const { mod } = loadHandlerWithMockedPg(async (sql) => {
      if (/SELECT id, customer_id, customer_name FROM appointments/.test(sql)) {
        return { rows: [{ id: 6, customer_id: null, customer_name: null }] };
      }
      return { rows: [] };
    }, stripeMock({
      createPaymentLinkImpl: async (params) => {
        captured = params;
        return { id: 'plink_456', url: 'https://buy.stripe.com/test_def456' };
      },
    }));

    const res = await mod.adminBillingPayLinkHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '6' }, body: { amountCents: 1000, note: 'balance' } }),
      fakeContext()
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured.description, 'AFRIKANADOLLZ balance — appointment #6');
    assert.deepStrictEqual(captured.metadata, { purpose: 'admin_link', appointmentId: '6', customerId: '' });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
