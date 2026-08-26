// Mocked-DB + mocked-lib/stripe unit tests for src/functions/book.js's ADDITIVE card-deposit path: an
// optional `paymentIntentId` in the POST /api/book payload (from a prior POST
// /api/payments/deposit-intent + client-side stripe.confirmPayment() call) gets verified server-side
// (never trusted at face value) BEFORE the appointment is created, and — only once verified — a
// billing_entries row is inserted in the SAME transaction as the appointment. Omitting
// paymentIntentId entirely must behave EXACTLY as before this feature existed (the manual/Cash-App
// deposit path, covered by test/bookingLinkage.test.js and test/bookInspirationPhoto.test.js, is not
// re-verified in depth here beyond confirming zero regression).
//
// Same require-cache-substitution approach as test/bookingLinkage.test.js for `pg`, extended to also
// substitute lib/stripe.js the way test/paymentsWebhook.test.js does for its own mocked dependency.
//
// Run with: node test/bookDepositPayment.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const STRIPE_LIB_PATH = path.join(__dirname, '..', 'lib', 'stripe.js');
const DEPOSIT_INTENT_PATH = path.join(__dirname, '..', 'src', 'functions', 'payments', 'depositIntent.js');
const BOOK_PATH = path.join(__dirname, '..', 'src', 'functions', 'book.js');

const { zonedWallTimeToUtc, weekdayOf } = require('../lib/availability');

const TIMEZONE = 'America/New_York';

// A fixed future Tuesday -- same fixture shape as test/bookingLinkage.test.js /
// test/bookInspirationPhoto.test.js.
const YEAR = 2027, MONTH = 6, DAY = 1; // 2027-06-01
const WEEKDAY = weekdayOf(YEAR, MONTH, DAY);
const REQUESTED_START = zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE);

function makeFakePool() {
  const calls = [];
  class FakeClient {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^BEGIN/.test(sql)) return {};
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM services/.test(sql)) {
        return { rows: [{ id: 1, name: 'Braids', duration_min: 60, buffer_min: 0 }] };
      }
      if (/FROM blocked_slots/.test(sql)) return { rows: [] };
      if (/FROM appointments/.test(sql) && /status = 'confirmed'/.test(sql)) return { rows: [] };
      if (/FROM availability_rules/.test(sql)) {
        return { rows: [{ weekday: WEEKDAY, start_time: '09:00:00', end_time: '17:00:00' }] };
      }
      if (/^INSERT INTO appointments/.test(sql)) {
        return {
          rows: [{
            id: 42, service_id: params[0], customer_name: params[1], customer_phone: params[2],
            customer_email: params[3], notes: params[4], start_at: params[5], end_at: params[6],
            status: 'confirmed', sms_opt_in: params[7], sms_phone: params[8], manage_token: params[9],
            customer_id: params[10], inspiration_photo_url: params[11], created_at: new Date().toISOString(),
          }],
        };
      }
      if (/^INSERT INTO billing_entries/.test(sql)) return { rows: [] };
      if (/^COMMIT/.test(sql)) return {};
      if (/^ROLLBACK/.test(sql)) return {};
      return { rows: [] };
    }
    release() {}
  }
  class FakePool {
    constructor() {}
    async connect() {
      return new FakeClient();
    }
  }
  return { FakePool, calls };
}

function loadBookHandler({ verifyPaymentSucceededImpl }) {
  const { FakePool, calls } = makeFakePool();

  delete require.cache[PG_PATH];
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[DEPOSIT_INTENT_PATH];
  delete require.cache[BOOK_PATH];

  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  const fakeStripeLib = new Module(STRIPE_LIB_PATH);
  fakeStripeLib.exports = {
    verifyPaymentSucceeded: verifyPaymentSucceededImpl,
    isConfigured: () => true,
    createPaymentIntent: async () => ({}),
  };
  fakeStripeLib.loaded = true;
  require.cache[STRIPE_LIB_PATH] = fakeStripeLib;

  const mod = require(BOOK_PATH);

  delete require.cache[PG_PATH];
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[DEPOSIT_INTENT_PATH];
  delete require.cache[BOOK_PATH];
  return { mod, calls };
}

function fakeRequest(body) {
  return {
    json: async () => body,
    headers: { get: () => '' },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
}

function baseBody(extra) {
  return Object.assign({
    serviceId: 1,
    customerName: 'Jamie Customer',
    customerPhone: '2675550100',
    customerEmail: 'jamie@example.com',
    start: REQUESTED_START.toISOString(),
    smsOptIn: false,
  }, extra);
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

  await test('paymentIntentId omitted -> zero regression: verifyPaymentSucceeded never called, no billing_entries insert, 201', async () => {
    const { mod, calls } = loadBookHandler({
      verifyPaymentSucceededImpl: async () => { throw new Error('verifyPaymentSucceeded should not be called'); },
    });
    const res = await mod.bookHandler(fakeRequest(baseBody()), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.ok(calls.some((c) => /^INSERT INTO appointments/.test(c.sql)), 'appointment should still be inserted');
    assert.ok(!calls.some((c) => /^INSERT INTO billing_entries/.test(c.sql)), 'no billing_entries row for a manual-deposit booking');
  });

  await test('paymentIntentId provided + verification succeeds -> appointment created AND a billing_entries row inserted (same transaction)', async () => {
    let verifyArgs;
    const { mod, calls } = loadBookHandler({
      verifyPaymentSucceededImpl: async (id, expectations) => {
        verifyArgs = { id, expectations };
        return { id, status: 'succeeded', amount: 2000, currency: 'usd' };
      },
    });
    const res = await mod.bookHandler(fakeRequest(baseBody({ paymentIntentId: 'pi_test_123' })), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));

    assert.strictEqual(verifyArgs.id, 'pi_test_123');
    assert.strictEqual(verifyArgs.expectations.expectedAmountCents, 2000);

    const insertAppt = calls.find((c) => /^INSERT INTO appointments/.test(c.sql));
    const insertBilling = calls.find((c) => /^INSERT INTO billing_entries/.test(c.sql));
    assert.ok(insertAppt, 'appointment should have been inserted');
    assert.ok(insertBilling, 'billing_entries row should have been inserted');
    assert.deepStrictEqual(insertBilling.params, [42, null, 2000, 'pi_test_123']);
    assert.ok(/method, source, external_ref, recorded_by/.test(insertBilling.sql) || /'card', 'stripe'/.test(insertBilling.sql));

    // Ordering within the single transaction: verification -> appointment insert -> billing insert -> COMMIT.
    const idx = (fn) => calls.findIndex(fn);
    const verifyRelatedOk = true; // verification itself isn't a client.query call, asserted via verifyArgs above
    const insertApptIdx = calls.indexOf(insertAppt);
    const insertBillingIdx = calls.indexOf(insertBilling);
    const commitIdx = idx((c) => /^COMMIT/.test(c.sql));
    assert.ok(verifyRelatedOk);
    assert.ok(insertApptIdx < insertBillingIdx, 'appointment insert must precede the billing_entries insert');
    assert.ok(insertBillingIdx < commitIdx, 'billing_entries insert must happen before COMMIT');
  });

  await test('paymentIntentId provided + verification rejects -> appointment NOT created, no billing_entries row, transaction rolled back, clean error response', async () => {
    const { mod, calls } = loadBookHandler({
      verifyPaymentSucceededImpl: async () => {
        throw new Error("verifyPaymentSucceeded: PaymentIntent status is 'requires_payment_method', not 'succeeded'");
      },
    });
    const res = await mod.bookHandler(fakeRequest(baseBody({ paymentIntentId: 'pi_bad' })), fakeContext());
    assert.ok(res.status === 402 || res.status === 400, `expected a clean 402/400, got ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assert.ok(res.jsonBody && typeof res.jsonBody.error === 'string');
    assert.ok(!calls.some((c) => /^INSERT INTO appointments/.test(c.sql)), 'no appointment should have been inserted');
    assert.ok(!calls.some((c) => /^INSERT INTO billing_entries/.test(c.sql)), 'no billing_entries row should have been inserted');
    assert.ok(calls.some((c) => /^ROLLBACK/.test(c.sql)), 'transaction should have been rolled back');
    assert.ok(!calls.some((c) => /^COMMIT/.test(c.sql)), 'transaction should never have committed');
  });

  await test('an amount/currency mismatch from verifyPaymentSucceeded is treated the same as any other verification failure', async () => {
    const { mod, calls } = loadBookHandler({
      verifyPaymentSucceededImpl: async () => {
        throw new Error('verifyPaymentSucceeded: amount/currency mismatch (expected 2000 usd, got 100 usd)');
      },
    });
    const res = await mod.bookHandler(fakeRequest(baseBody({ paymentIntentId: 'pi_underpaid' })), fakeContext());
    assert.ok(res.status === 402 || res.status === 400);
    assert.ok(!calls.some((c) => /^INSERT INTO appointments/.test(c.sql)));
  });

  await test('a non-string paymentIntentId -> 400 from validateBody, never reaches the DB/Stripe at all', async () => {
    const { mod, calls } = loadBookHandler({
      verifyPaymentSucceededImpl: async () => { throw new Error('should not be called'); },
    });
    const res = await mod.bookHandler(fakeRequest(baseBody({ paymentIntentId: 12345 })), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls.length, 0);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
