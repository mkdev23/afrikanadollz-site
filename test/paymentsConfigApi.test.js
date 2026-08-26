// Unit tests for src/functions/payments/config.js (GET /api/payments/config). No DB/auth involved --
// this endpoint is deliberately public (see its header comment), so no require-cache mocking needed.
//
// Run with: node test/paymentsConfigApi.test.js
'use strict';

const assert = require('assert');
const { paymentsConfigHandler } = require('../src/functions/payments/config');

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

  await test('503 when STRIPE_PUBLISHABLE_KEY is unset', async () => {
    await withEnv({ STRIPE_PUBLISHABLE_KEY: undefined }, async () => {
      const res = await paymentsConfigHandler({}, fakeContext());
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.jsonBody.code, 'not_configured');
    });
  });

  await test('503 for the shipped REPLACE_ME_ placeholder', async () => {
    await withEnv({ STRIPE_PUBLISHABLE_KEY: 'REPLACE_ME_pk_test_or_live_from_stripe_dashboard' }, async () => {
      const res = await paymentsConfigHandler({}, fakeContext());
      assert.strictEqual(res.status, 503);
    });
  });

  await test('200 with the publishable key when a real-looking value is set', async () => {
    await withEnv({ STRIPE_PUBLISHABLE_KEY: 'pk_test_realvalue123' }, async () => {
      const res = await paymentsConfigHandler({}, fakeContext());
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.jsonBody.publishableKey, 'pk_test_realvalue123');
    });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
