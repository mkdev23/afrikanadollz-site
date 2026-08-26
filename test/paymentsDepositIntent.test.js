// Mocked-lib/stripe unit tests for src/functions/payments/depositIntent.js (POST
// /api/payments/deposit-intent). Same require-cache-substitution approach as
// test/paymentsWebhook.test.js / test/paymentsConfigApi.test.js: lib/stripe.js is substituted with a
// fake so isConfigured()/createPaymentIntent() behavior is controlled by the test rather than needing
// a real Stripe secret key or network access.
//
// Run with: node test/paymentsDepositIntent.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const STRIPE_LIB_PATH = path.join(__dirname, '..', 'lib', 'stripe.js');
const DEPOSIT_INTENT_PATH = path.join(__dirname, '..', 'src', 'functions', 'payments', 'depositIntent.js');

function loadHandler({ isConfiguredImpl, createPaymentIntentImpl }) {
  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[DEPOSIT_INTENT_PATH];

  const fakeStripeLib = new Module(STRIPE_LIB_PATH);
  fakeStripeLib.exports = {
    isConfigured: isConfiguredImpl,
    createPaymentIntent: createPaymentIntentImpl,
  };
  fakeStripeLib.loaded = true;
  require.cache[STRIPE_LIB_PATH] = fakeStripeLib;

  const mod = require(DEPOSIT_INTENT_PATH);

  delete require.cache[STRIPE_LIB_PATH];
  delete require.cache[DEPOSIT_INTENT_PATH];
  return mod;
}

function fakeRequest(body) {
  return {
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

  await test('DEPOSIT_AMOUNT_CENTS export equals 2000 ($20, matching help.html/book.html copy)', async () => {
    const mod = loadHandler({ isConfiguredImpl: () => true, createPaymentIntentImpl: async () => ({}) });
    assert.strictEqual(mod.DEPOSIT_AMOUNT_CENTS, 2000);
  });

  await test('503 with code:not_configured when Stripe is not configured (expected pre-launch state)', async () => {
    const mod = loadHandler({
      isConfiguredImpl: () => false,
      createPaymentIntentImpl: async () => { throw new Error('should not be called'); },
    });
    const res = await mod.depositIntentHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.jsonBody.code, 'not_configured');
  });

  await test('happy path: returns {clientSecret, paymentIntentId, amountCents === 2000}', async () => {
    let capturedArgs;
    const mod = loadHandler({
      isConfiguredImpl: () => true,
      createPaymentIntentImpl: async (args) => {
        capturedArgs = args;
        return { id: 'pi_abc123', clientSecret: 'pi_abc123_secret_xyz', status: 'requires_payment_method' };
      },
    });
    const res = await mod.depositIntentHandler(fakeRequest({ serviceId: 7 }), fakeContext());
    assert.strictEqual(res.status, 200, JSON.stringify(res.jsonBody));
    assert.strictEqual(res.jsonBody.amountCents, 2000);
    assert.strictEqual(res.jsonBody.clientSecret, 'pi_abc123_secret_xyz');
    assert.strictEqual(res.jsonBody.paymentIntentId, 'pi_abc123');

    // The client-supplied serviceId must only ever influence description/metadata, never the amount.
    assert.strictEqual(capturedArgs.amountCents, 2000);
    assert.strictEqual(capturedArgs.currency, 'usd');
    assert.strictEqual(capturedArgs.metadata.purpose, 'deposit');
    assert.strictEqual(capturedArgs.metadata.serviceId, '7');
    assert.strictEqual(capturedArgs.description, 'AFRIKANADOLLZ appointment deposit');
  });

  await test('serviceId omitted -> still works, metadata.serviceId is an empty string', async () => {
    let capturedArgs;
    const mod = loadHandler({
      isConfiguredImpl: () => true,
      createPaymentIntentImpl: async (args) => {
        capturedArgs = args;
        return { id: 'pi_x', clientSecret: 'secret_x', status: 'requires_payment_method' };
      },
    });
    const res = await mod.depositIntentHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedArgs.amountCents, 2000);
    assert.strictEqual(capturedArgs.metadata.serviceId, '');
  });

  await test('a malformed/empty JSON body does not error the request -- serviceId just falls back to empty', async () => {
    let capturedArgs;
    const mod = loadHandler({
      isConfiguredImpl: () => true,
      createPaymentIntentImpl: async (args) => {
        capturedArgs = args;
        return { id: 'pi_y', clientSecret: 'secret_y', status: 'requires_payment_method' };
      },
    });
    const res = await mod.depositIntentHandler(fakeRequest(undefined), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedArgs.metadata.serviceId, '');
  });

  await test('a downstream Stripe error surfaces as a clean 500, never a thrown exception', async () => {
    const mod = loadHandler({
      isConfiguredImpl: () => true,
      createPaymentIntentImpl: async () => { throw new Error('Stripe API unreachable'); },
    });
    const res = await mod.depositIntentHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 500);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
