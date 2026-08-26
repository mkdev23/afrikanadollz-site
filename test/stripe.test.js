// Mocked-Stripe-client unit tests for lib/stripe.js (no live Stripe account/keys required). Every
// exported function takes an optional trailing `_client` override -- mirrors test/shopify.test.js's
// `_fetch`-injection style, adapted for an SDK-shaped dependency instead of a fetch-shaped one.
//
// Run with: node test/stripe.test.js
'use strict';

const assert = require('assert');
const {
  isConfigured,
  createPaymentIntent,
  retrievePaymentIntent,
  verifyPaymentSucceeded,
  createPaymentLink,
  constructWebhookEvent,
} = require('../lib/stripe');

function fakeStripeClient(overrides) {
  return {
    paymentIntents: {
      create: async () => ({ id: 'pi_fake', client_secret: 'pi_fake_secret', status: 'requires_payment_method' }),
      retrieve: async () => ({ id: 'pi_fake', status: 'succeeded', amount: 2000, currency: 'usd' }),
      ...(overrides && overrides.paymentIntents),
    },
    prices: {
      create: async () => ({ id: 'price_fake' }),
      ...(overrides && overrides.prices),
    },
    paymentLinks: {
      create: async () => ({ id: 'plink_fake', url: 'https://buy.stripe.com/fake' }),
      ...(overrides && overrides.paymentLinks),
    },
    webhooks: {
      constructEvent: (rawBody, sig, secret) => ({ id: 'evt_fake', type: 'payment_intent.succeeded', rawBody, sig, secret }),
      ...(overrides && overrides.webhooks),
    },
  };
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

  const withEnv = async (envOverrides, fn) => {
    const prev = {};
    for (const key of Object.keys(envOverrides)) {
      prev[key] = process.env[key];
      if (envOverrides[key] === undefined) delete process.env[key];
      else process.env[key] = envOverrides[key];
    }
    try {
      await fn();
    } finally {
      for (const key of Object.keys(envOverrides)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  };

  // ---- isConfigured ----
  await test('isConfigured: false when STRIPE_SECRET_KEY unset', async () => {
    await withEnv({ STRIPE_SECRET_KEY: undefined }, async () => {
      assert.strictEqual(isConfigured(), false);
    });
  });
  await test('isConfigured: false for the shipped REPLACE_ME_ placeholder', async () => {
    await withEnv({ STRIPE_SECRET_KEY: 'REPLACE_ME_sk_test_or_live_from_stripe_dashboard' }, async () => {
      assert.strictEqual(isConfigured(), false);
    });
  });
  await test('isConfigured: true for a real-looking key', async () => {
    await withEnv({ STRIPE_SECRET_KEY: 'sk_test_abc123' }, async () => {
      assert.strictEqual(isConfigured(), true);
    });
  });

  // ---- createPaymentIntent ----
  await test('createPaymentIntent: happy path returns id/clientSecret/status', async () => {
    const client = fakeStripeClient();
    const result = await createPaymentIntent({ amountCents: 2000, metadata: { purpose: 'deposit' } }, client);
    assert.deepStrictEqual(result, { id: 'pi_fake', clientSecret: 'pi_fake_secret', status: 'requires_payment_method' });
  });
  await test('createPaymentIntent: passes amount/currency/metadata through to Stripe', async () => {
    let captured;
    const client = fakeStripeClient({
      paymentIntents: {
        create: async (args) => {
          captured = args;
          return { id: 'pi_x', client_secret: 'secret_x', status: 'requires_payment_method' };
        },
      },
    });
    await createPaymentIntent({ amountCents: 2000, currency: 'usd', metadata: { purpose: 'deposit', appointmentId: '' } }, client);
    assert.strictEqual(captured.amount, 2000);
    assert.strictEqual(captured.currency, 'usd');
    assert.strictEqual(captured.metadata.purpose, 'deposit');
    assert.strictEqual(captured.automatic_payment_methods.enabled, true);
  });
  await test('createPaymentIntent: rejects non-integer amountCents', async () => {
    await assert.rejects(() => createPaymentIntent({ amountCents: 20.5, metadata: {} }, fakeStripeClient()), /positive integer/);
  });
  await test('createPaymentIntent: rejects zero/negative amountCents', async () => {
    await assert.rejects(() => createPaymentIntent({ amountCents: 0, metadata: {} }, fakeStripeClient()), /positive integer/);
    await assert.rejects(() => createPaymentIntent({ amountCents: -100, metadata: {} }, fakeStripeClient()), /positive integer/);
  });

  // ---- retrievePaymentIntent ----
  await test('retrievePaymentIntent: passes through the Stripe response', async () => {
    const client = fakeStripeClient({
      paymentIntents: { retrieve: async (id) => ({ id, status: 'succeeded', amount: 4200, currency: 'usd' }) },
    });
    const result = await retrievePaymentIntent('pi_abc', client);
    assert.strictEqual(result.id, 'pi_abc');
    assert.strictEqual(result.status, 'succeeded');
  });

  // ---- verifyPaymentSucceeded: the actual trust boundary ----
  await test('verifyPaymentSucceeded: resolves when status succeeded and amount/currency match', async () => {
    const client = fakeStripeClient({
      paymentIntents: { retrieve: async () => ({ id: 'pi_ok', status: 'succeeded', amount: 2000, currency: 'usd' }) },
    });
    const result = await verifyPaymentSucceeded('pi_ok', { expectedAmountCents: 2000 }, client);
    assert.strictEqual(result.status, 'succeeded');
  });
  await test('verifyPaymentSucceeded: rejects when status is not succeeded', async () => {
    const client = fakeStripeClient({
      paymentIntents: { retrieve: async () => ({ id: 'pi_bad', status: 'requires_action', amount: 2000, currency: 'usd' }) },
    });
    await assert.rejects(() => verifyPaymentSucceeded('pi_bad', { expectedAmountCents: 2000 }, client), /not 'succeeded'/);
  });
  await test('verifyPaymentSucceeded: rejects on amount mismatch (a client cannot pay 1 cent and claim a $20 deposit)', async () => {
    const client = fakeStripeClient({
      paymentIntents: { retrieve: async () => ({ id: 'pi_cheap', status: 'succeeded', amount: 1, currency: 'usd' }) },
    });
    await assert.rejects(() => verifyPaymentSucceeded('pi_cheap', { expectedAmountCents: 2000 }, client), /mismatch/);
  });
  await test('verifyPaymentSucceeded: rejects on currency mismatch', async () => {
    const client = fakeStripeClient({
      paymentIntents: { retrieve: async () => ({ id: 'pi_eur', status: 'succeeded', amount: 2000, currency: 'eur' }) },
    });
    await assert.rejects(() => verifyPaymentSucceeded('pi_eur', { expectedAmountCents: 2000, expectedCurrency: 'usd' }, client), /mismatch/);
  });
  await test('verifyPaymentSucceeded: rejects a missing/blank paymentIntentId without calling Stripe', async () => {
    let called = false;
    const client = fakeStripeClient({ paymentIntents: { retrieve: async () => { called = true; } } });
    await assert.rejects(() => verifyPaymentSucceeded('', { expectedAmountCents: 2000 }, client), /paymentIntentId is required/);
    assert.strictEqual(called, false);
  });

  // ---- createPaymentLink ----
  await test('createPaymentLink: happy path creates a Price then a Payment Link, returns id/url', async () => {
    const client = fakeStripeClient();
    const result = await createPaymentLink({ amountCents: 5000, description: 'Balance', metadata: { appointmentId: '7' } }, client);
    assert.deepStrictEqual(result, { id: 'plink_fake', url: 'https://buy.stripe.com/fake' });
  });
  await test('createPaymentLink: the Price uses the requested amount/currency, and the link references that Price', async () => {
    let priceArgs;
    let linkArgs;
    const client = fakeStripeClient({
      prices: { create: async (args) => { priceArgs = args; return { id: 'price_captured' }; } },
      paymentLinks: { create: async (args) => { linkArgs = args; return { id: 'plink_x', url: 'https://buy.stripe.com/x' }; } },
    });
    await createPaymentLink({ amountCents: 5000, currency: 'usd', description: 'Balance', metadata: { appointmentId: '7' } }, client);
    assert.strictEqual(priceArgs.unit_amount, 5000);
    assert.strictEqual(priceArgs.currency, 'usd');
    assert.strictEqual(linkArgs.line_items[0].price, 'price_captured');
    assert.strictEqual(linkArgs.metadata.appointmentId, '7');
  });
  await test('createPaymentLink: rejects non-positive amountCents', async () => {
    await assert.rejects(() => createPaymentLink({ amountCents: 0, description: 'x', metadata: {} }, fakeStripeClient()), /positive integer/);
  });

  // ---- constructWebhookEvent ----
  await test('constructWebhookEvent: passes raw body/signature/secret through to Stripe SDK verification', async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test123' }, async () => {
      const client = fakeStripeClient();
      const event = constructWebhookEvent('{"raw":"body"}', 'sig_header_value', client);
      assert.strictEqual(event.type, 'payment_intent.succeeded');
      assert.strictEqual(event.rawBody, '{"raw":"body"}');
      assert.strictEqual(event.sig, 'sig_header_value');
      assert.strictEqual(event.secret, 'whsec_test123');
    });
  });
  await test('constructWebhookEvent: throws without STRIPE_WEBHOOK_SECRET configured', async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: undefined }, async () => {
      assert.throws(() => constructWebhookEvent('{}', 'sig', fakeStripeClient()), /STRIPE_WEBHOOK_SECRET not configured/);
    });
  });
  await test('constructWebhookEvent: a bad signature throws (verified by delegating to the mock throwing, matching real SDK behavior)', async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test123' }, async () => {
      const client = fakeStripeClient({
        webhooks: {
          constructEvent: () => {
            throw new Error('No signatures found matching the expected signature for payload');
          },
        },
      });
      assert.throws(() => constructWebhookEvent('{}', 'bad_sig', client), /No signatures found/);
    });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
