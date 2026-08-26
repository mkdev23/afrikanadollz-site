// Mocked-DB unit tests for src/functions/admin/integrationsStatus.js
// (GET /api/staffconsole/integrations-status). Same require-cache-substitution approach as
// test/adminBillingApi.test.js.
//
// Run with: node test/adminIntegrationsStatusApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const HANDLER_PATH = path.join(__dirname, '..', 'src', 'functions', 'admin', 'integrationsStatus.js');

const { signSession, SESSION_COOKIE_NAME } = require('../lib/adminAuth');

function makeFakePool() {
  class FakePool {
    constructor() {}
    async query(sql) {
      if (/^SELECT session_epoch FROM admin_account WHERE id = 1$/.test(sql)) {
        return { rows: [{ session_epoch: 1 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  }
  return FakePool;
}

function loadHandler() {
  const FakePool = makeFakePool();
  delete require.cache[PG_PATH];
  delete require.cache[HANDLER_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(HANDLER_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[HANDLER_PATH];
  return mod;
}

function fakeRequest({ cookie } = {}) {
  return { headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : null) } };
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

  await test('401 without admin auth', async () => {
    const mod = loadHandler();
    const res = await mod.adminIntegrationsStatusHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('both disconnected when only REPLACE_ME_ placeholders are set', async () => {
    await withEnv(
      {
        SHOPIFY_STORE_DOMAIN: 'REPLACE_ME_yourstorename.myshopify.com',
        SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'REPLACE_ME_storefront_access_token_from_shopify_admin',
        STRIPE_SECRET_KEY: 'REPLACE_ME_sk_test_or_live_from_stripe_dashboard',
      },
      async () => {
        const mod = loadHandler();
        const res = await mod.adminIntegrationsStatusHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.jsonBody, {
          shopify: { connected: false, domain: null },
          stripe: { connected: false },
        });
      }
    );
  });

  await test('shopify connected + domain shown (never the token) when both real values are set', async () => {
    await withEnv(
      {
        SHOPIFY_STORE_DOMAIN: 'afrikanadollz.myshopify.com',
        SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'shpat_real_token_value',
        STRIPE_SECRET_KEY: 'REPLACE_ME_sk_test_or_live_from_stripe_dashboard',
      },
      async () => {
        const mod = loadHandler();
        const res = await mod.adminIntegrationsStatusHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.jsonBody.shopify.connected, true);
        assert.strictEqual(res.jsonBody.shopify.domain, 'afrikanadollz.myshopify.com');
        assert.strictEqual(JSON.stringify(res.jsonBody).includes('shpat_real_token_value'), false);
      }
    );
  });

  await test('shopify NOT connected if only one of the two env vars is real (partial config is not "connected")', async () => {
    await withEnv(
      {
        SHOPIFY_STORE_DOMAIN: 'afrikanadollz.myshopify.com',
        SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'REPLACE_ME_storefront_access_token_from_shopify_admin',
      },
      async () => {
        const mod = loadHandler();
        const res = await mod.adminIntegrationsStatusHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
        assert.strictEqual(res.jsonBody.shopify.connected, false);
        assert.strictEqual(res.jsonBody.shopify.domain, null);
      }
    );
  });

  await test('stripe connected when a real-looking key is set, never returns the key itself', async () => {
    await withEnv({ STRIPE_SECRET_KEY: 'sk_test_abc123realkey' }, async () => {
      const mod = loadHandler();
      const res = await mod.adminIntegrationsStatusHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
      assert.strictEqual(res.jsonBody.stripe.connected, true);
      assert.strictEqual(JSON.stringify(res.jsonBody).includes('sk_test_abc123realkey'), false);
    });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
