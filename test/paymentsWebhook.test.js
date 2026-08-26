// Mocked-DB + mocked-lib/stripe unit tests for src/functions/payments/webhook.js
// (POST /api/payments/webhook). Same require-cache-substitution approach as
// test/adminBillingApi.test.js for `pg`, extended to also substitute lib/stripe.js so signature
// verification behavior is controlled by the test rather than needing a real Stripe webhook secret.
//
// Run with: node test/paymentsWebhook.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const STRIPE_LIB_PATH = path.join(__dirname, '..', 'lib', 'stripe.js');
const WEBHOOK_PATH = path.join(__dirname, '..', 'src', 'functions', 'payments', 'webhook.js');

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

function loadHandler({ queryImpl, constructWebhookEventImpl }) {
  const { FakePool, calls } = makeFakePool(queryImpl);

  delete require.cache[PG_PATH];
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[WEBHOOK_PATH];

  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  const fakeStripeLib = new Module(STRIPE_LIB_PATH);
  fakeStripeLib.exports = { constructWebhookEvent: constructWebhookEventImpl };
  fakeStripeLib.loaded = true;
  require.cache[STRIPE_LIB_PATH] = fakeStripeLib;

  const mod = require(WEBHOOK_PATH);

  delete require.cache[PG_PATH];
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[WEBHOOK_PATH];
  return { mod, calls };
}

function fakeRequest({ rawBody = '{}', signature = 'sig_test' } = {}) {
  return {
    text: async () => rawBody,
    headers: { get: (name) => (name.toLowerCase() === 'stripe-signature' ? signature : null) },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
}

function fakeIntentSucceededEvent({ id = 'pi_123', amount = 2000, metadata = {} } = {}) {
  return { type: 'payment_intent.succeeded', data: { object: { id, amount, currency: 'usd', metadata } } };
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

  await test('rejects with 400 when signature verification throws (never processes the event)', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async () => ({ rows: [] }),
      constructWebhookEventImpl: () => {
        throw new Error('No signatures found matching the expected signature for payload');
      },
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls.length, 0);
  });

  await test('payment_intent.succeeded with no metadata.appointmentId: 200, no DB write (deposit-flow safety net, not an auto-resolver)', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async () => ({ rows: [] }),
      constructWebhookEventImpl: () => fakeIntentSucceededEvent({ metadata: { purpose: 'deposit' } }),
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 0);
  });

  await test('payment_intent.succeeded with metadata.appointmentId: looks up the appointment then inserts a card/stripe billing_entries row', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async (sql, params, i) => {
        if (i === 0) {
          assert.ok(/SELECT id, customer_id FROM appointments WHERE id = \$1/.test(sql));
          assert.deepStrictEqual(params, ['42']);
          return { rows: [{ id: 42, customer_id: 9 }] };
        }
        assert.ok(/INSERT INTO billing_entries/.test(sql));
        assert.deepStrictEqual(params, ['42', 9, 2000, 'pi_123']);
        return { rows: [] };
      },
      constructWebhookEventImpl: () => fakeIntentSucceededEvent({ id: 'pi_123', amount: 2000, metadata: { purpose: 'balance', appointmentId: '42' } }),
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2);
  });

  await test('unknown appointmentId in metadata: skips the insert, still returns 200 (nothing to retry)', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async () => ({ rows: [] }), // appointment lookup returns nothing
      constructWebhookEventImpl: () => fakeIntentSucceededEvent({ metadata: { appointmentId: '999' } }),
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 1); // only the SELECT, no INSERT attempted
  });

  await test('redelivered event (duplicate external_ref): unique-violation on insert is swallowed, still 200', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async (sql, params, i) => {
        if (i === 0) return { rows: [{ id: 42, customer_id: 9 }] };
        const err = new Error('duplicate key value violates unique constraint "idx_billing_entries_external_ref"');
        err.code = '23505';
        throw err;
      },
      constructWebhookEventImpl: () => fakeIntentSucceededEvent({ id: 'pi_dup', metadata: { appointmentId: '42' } }),
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2);
  });

  await test('a real (non-duplicate) DB error surfaces as 500, so Stripe retries delivery', async () => {
    const { mod } = loadHandler({
      queryImpl: async (sql, params, i) => {
        if (i === 0) return { rows: [{ id: 42, customer_id: 9 }] };
        throw new Error('connection reset');
      },
      constructWebhookEventImpl: () => fakeIntentSucceededEvent({ metadata: { appointmentId: '42' } }),
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 500);
  });

  await test('ignores unrelated event types (e.g. payment_intent.created) with a clean 200', async () => {
    const { mod, calls } = loadHandler({
      queryImpl: async () => ({ rows: [] }),
      constructWebhookEventImpl: () => ({ type: 'payment_intent.created', data: { object: { id: 'pi_new' } } }),
    });
    const res = await mod.paymentsWebhookHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 0);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
