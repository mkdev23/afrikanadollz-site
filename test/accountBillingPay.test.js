// Mocked-DB + mocked-lib/stripe unit tests for src/functions/account/billingPay.js
// (POST /api/account/billing/pay). Same require-cache-substitution approach test/accountApi.test.js
// uses for `pg` (real requireCustomer()/signCustomerSession() from lib/customerAuth.js — no mocking
// of auth itself) combined with test/paymentsWebhook.test.js's approach for substituting lib/stripe.js
// so createPaymentIntent()'s behavior/call args are controlled by the test rather than needing a real
// Stripe key.
//
// Run with: node test/accountBillingPay.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const STRIPE_LIB_PATH = path.join(__dirname, '..', 'lib', 'stripe.js');
const BILLING_PAY_PATH = path.join(__dirname, '..', 'src', 'functions', 'account', 'billingPay.js');

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

function loadHandler({ queryImpl, isConfigured = () => true, createPaymentIntent }) {
  const { FakePool, calls } = makeFakePool(queryImpl);
  const stripeCalls = [];

  delete require.cache[PG_PATH];
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[BILLING_PAY_PATH];

  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  const fakeStripeLib = new Module(STRIPE_LIB_PATH);
  fakeStripeLib.exports = {
    isConfigured,
    createPaymentIntent:
      createPaymentIntent ||
      (async (params) => {
        stripeCalls.push(params);
        return { id: 'pi_test', clientSecret: 'pi_test_secret', status: 'requires_payment_method' };
      }),
  };
  fakeStripeLib.loaded = true;
  require.cache[STRIPE_LIB_PATH] = fakeStripeLib;

  const mod = require(BILLING_PAY_PATH);

  delete require.cache[PG_PATH];
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[BILLING_PAY_PATH];
  return { mod, calls, stripeCalls };
}

function fakeRequest({ cookie, body } = {}) {
  return {
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : null) },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
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

  // Standard "appointment 42 belongs to customer 7, service price is $50.00 (5000 cents)" query
  // handler: call 0 is the ownership-scoped appointment+price lookup, call 1 sums prior
  // billing_entries for that appointment.
  function apptAndPaidQueryImpl({ ownerCustomerId = 7, priceCents = 5000, paidCents = 0 } = {}) {
    return async (sql, params, i) => {
      if (i === 0) {
        assert.ok(/JOIN services s ON s\.id = a\.service_id/.test(sql));
        assert.ok(/WHERE a\.id = \$1 AND a\.customer_id = \$2/.test(sql));
        const [apptId, customerId] = params;
        if (Number(customerId) !== ownerCustomerId) return { rows: [] }; // simulate real scoping
        return { rows: [{ id: apptId, price_cents: priceCents }] };
      }
      assert.ok(/SUM\(amount_cents\)/.test(sql));
      return { rows: [{ paid: paidCents }] };
    };
  }

  // ---------------- auth ----------------

  await test('401 with no session cookie', async () => {
    const { mod, calls } = loadHandler({ queryImpl: async () => ({ rows: [] }) });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(calls.length, 0);
  });

  // ---------------- not configured ----------------

  await test('503 when Stripe is not configured (checked before touching the DB)', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async () => ({ rows: [] }),
      isConfigured: () => false,
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.jsonBody.code, 'not_configured');
    assert.strictEqual(calls.length, 0);
  });

  // ---------------- body validation ----------------

  await test('400 when appointmentId is missing/invalid', async () => {
    const { mod } = loadHandler({ queryImpl: async () => ({ rows: [] }) });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: {} }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  // ---------------- IDOR ----------------

  await test('IDOR: a customer cannot create a PaymentIntent against another customer\'s appointment — 404, no PaymentIntent created', async () => {
    const { mod, calls, stripeCalls } = loadHandler({
      // Appointment 42 actually belongs to customer 7; the request below is signed in as customer 99.
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7 }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(99), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
    assert.strictEqual(calls.length, 1); // stopped at the ownership-scoped lookup, never summed payments or called Stripe
    assert.strictEqual(stripeCalls.length, 0);
  });

  await test('404 when the appointment does not exist at all (same response shape as IDOR — no existence leak)', async () => {
    const { mod } = loadHandler({ queryImpl: async () => ({ rows: [] }) });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 9999 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  // ---------------- remainingCents math ----------------

  await test('remainingCents with zero prior payments: full price_cents is owed', async () => {
    const { mod, stripeCalls } = loadHandler({
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7, priceCents: 5000, paidCents: 0 }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.amountCents, 5000);
    assert.strictEqual(stripeCalls[0].amountCents, 5000);
  });

  await test('remainingCents with partial prior payments mixing manual + card sources: both count toward paidSoFar', async () => {
    // The SUM query doesn't distinguish source/method in this handler (billing_entries.amount_cents
    // is summed unconditionally by appointment_id) -- mirrored here by paidCents already being the
    // combined total of a manual entry ($15) + a card entry ($10) = $25 paid against a $50 price.
    const { mod, stripeCalls } = loadHandler({
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7, priceCents: 5000, paidCents: 2500 }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.amountCents, 2500);
    assert.strictEqual(stripeCalls[0].amountCents, 2500);
  });

  await test('balance already fully paid: 400, no PaymentIntent created', async () => {
    const { mod, stripeCalls } = loadHandler({
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7, priceCents: 5000, paidCents: 5000 }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(stripeCalls.length, 0);
  });

  await test('balance overpaid (paid > price): also 400, no PaymentIntent created', async () => {
    const { mod, stripeCalls } = loadHandler({
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7, priceCents: 5000, paidCents: 6000 }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(stripeCalls.length, 0);
  });

  // ---------------- metadata shape ----------------

  await test('metadata passed to createPaymentIntent has purpose:\'balance\' and appointmentId/customerId as strings', async () => {
    const { mod, stripeCalls } = loadHandler({
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7, priceCents: 5000, paidCents: 0 }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(stripeCalls[0].metadata, {
      purpose: 'balance',
      appointmentId: '42',
      customerId: '7',
    });
    assert.strictEqual(typeof stripeCalls[0].metadata.appointmentId, 'string');
    assert.strictEqual(typeof stripeCalls[0].metadata.customerId, 'string');
    assert.strictEqual(stripeCalls[0].currency, 'usd');
    assert.ok(res.jsonBody.clientSecret);
  });

  // ---------------- service with no price set ----------------

  await test('400 when the appointment\'s service has no price set (price_cents NULL)', async () => {
    const { mod, stripeCalls } = loadHandler({
      queryImpl: apptAndPaidQueryImpl({ ownerCustomerId: 7, priceCents: null }),
    });
    const res = await mod.accountBillingPayHandler(
      fakeRequest({ cookie: COOKIE_FOR(7), body: { appointmentId: 42 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(stripeCalls.length, 0);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
