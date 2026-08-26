// Unit tests for src/functions/shopify/{products,cart}.js's request validation and status-code mapping,
// with lib/shopify.js mocked out via require-cache substitution -- same no-live-credentials approach as
// test/styleSuggest.test.js uses for lib/openai.js.
//
// Run with: node test/shopifyApi.test.js
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const PRODUCTS_PATH = path.join(__dirname, '..', 'src', 'functions', 'shopify', 'products.js');
const CART_PATH = path.join(__dirname, '..', 'src', 'functions', 'shopify', 'cart.js');
const SHOPIFY_LIB_PATH = path.join(__dirname, '..', 'lib', 'shopify.js');

// Azure Functions' `app.http(...)` registration call runs at module load time and needs the real
// @azure/functions package (already a project dependency) -- that part is NOT mocked. Only
// lib/shopify.js's network-touching functions are mocked, via a require-cache substitution
// (Module._cache), so this stays a "mocked SDK/network, real everything else" unit test.
function loadHandlerWithMockedShopify(modulePath, mockExports) {
  delete require.cache[modulePath];
  delete require.cache[SHOPIFY_LIB_PATH];
  const fakeModule = new Module(SHOPIFY_LIB_PATH);
  fakeModule.exports = mockExports;
  fakeModule.loaded = true;
  require.cache[SHOPIFY_LIB_PATH] = fakeModule;
  const mod = require(modulePath);
  delete require.cache[SHOPIFY_LIB_PATH];
  delete require.cache[modulePath];
  return mod;
}

function fakeRequest(body) {
  return { json: async () => body };
}
function fakeContext() {
  const errors = [];
  const warnings = [];
  return { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args), errors, warnings };
}

const SAMPLE_PRODUCTS = [
  { id: 'gid://shopify/Product/1', n: 'Silk Straight 24"', m: 'Wig', p: 320, currency: 'USD', img: 'x.jpg', tag: 'Bestseller', variantId: 'gid://shopify/ProductVariant/101', availableForSale: true },
];

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

  // ---- GET /api/shopify/products ----

  await test('products handler returns 200 with the products array on success', async () => {
    const { shopifyProductsHandler } = loadHandlerWithMockedShopify(PRODUCTS_PATH, {
      getProducts: async () => SAMPLE_PRODUCTS,
    });
    const res = await shopifyProductsHandler({}, fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.products, SAMPLE_PRODUCTS);
  });

  await test('products handler returns 503 with code "not_configured" when Shopify env vars are missing', async () => {
    const ctx = fakeContext();
    const { shopifyProductsHandler } = loadHandlerWithMockedShopify(PRODUCTS_PATH, {
      getProducts: async () => {
        throw new Error('SHOPIFY_STORE_DOMAIN/SHOPIFY_STOREFRONT_ACCESS_TOKEN not configured');
      },
    });
    const res = await shopifyProductsHandler({}, ctx);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.jsonBody.code, 'not_configured');
  });

  await test('products handler returns 502 (not a 500 crash) on a network/GraphQL failure', async () => {
    const ctx = fakeContext();
    const { shopifyProductsHandler } = loadHandlerWithMockedShopify(PRODUCTS_PATH, {
      getProducts: async () => {
        throw new Error('Shopify Storefront API request failed: 500 Internal Server Error');
      },
    });
    const res = await shopifyProductsHandler({}, ctx);
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.jsonBody.code, 'upstream_error');
  });

  // ---- POST /api/shopify/cart ----

  await test('cart handler validateBody accepts a well-formed request', () => {
    const { validateBody } = loadHandlerWithMockedShopify(CART_PATH, { createCart: async () => ({}) });
    const errors = validateBody({ lines: [{ variantId: 'gid://shopify/ProductVariant/101', quantity: 2 }] });
    assert.deepStrictEqual(errors, []);
  });

  await test('cart handler validateBody rejects a missing/empty lines array', () => {
    const { validateBody } = loadHandlerWithMockedShopify(CART_PATH, { createCart: async () => ({}) });
    assert.ok(validateBody({}).some((e) => /lines/.test(e)));
    assert.ok(validateBody({ lines: [] }).some((e) => /lines/.test(e)));
  });

  await test('cart handler validateBody rejects a non-Shopify-shaped variantId', () => {
    const { validateBody } = loadHandlerWithMockedShopify(CART_PATH, { createCart: async () => ({}) });
    const errors = validateBody({ lines: [{ variantId: 'not-a-real-gid', quantity: 1 }] });
    assert.ok(errors.some((e) => /variantId/.test(e)));
  });

  await test('cart handler validateBody rejects a bad quantity', () => {
    const { validateBody } = loadHandlerWithMockedShopify(CART_PATH, { createCart: async () => ({}) });
    const errors = validateBody({ lines: [{ variantId: 'gid://shopify/ProductVariant/101', quantity: 0 }] });
    assert.ok(errors.some((e) => /quantity/.test(e)));
  });

  await test('cart handler returns 400 with details when validation fails, without calling createCart', async () => {
    let called = false;
    const { shopifyCartHandler } = loadHandlerWithMockedShopify(CART_PATH, {
      createCart: async () => {
        called = true;
        return {};
      },
    });
    const res = await shopifyCartHandler(fakeRequest({ lines: [] }), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.ok(Array.isArray(res.jsonBody.details));
    assert.strictEqual(called, false);
  });

  await test('cart handler returns 200 + checkoutUrl on success, and forwards lines through untouched', async () => {
    let received;
    const { shopifyCartHandler } = loadHandlerWithMockedShopify(CART_PATH, {
      createCart: async ({ lines }) => {
        received = lines;
        return { cartId: 'gid://shopify/Cart/abc', checkoutUrl: 'https://x.myshopify.com/cart/c/abc' };
      },
    });
    const body = { lines: [{ variantId: 'gid://shopify/ProductVariant/101', quantity: 1 }] };
    const res = await shopifyCartHandler(fakeRequest(body), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.checkoutUrl, 'https://x.myshopify.com/cart/c/abc');
    assert.deepStrictEqual(received, body.lines);
  });

  await test('cart handler returns 503 with code "not_configured" when Shopify env vars are missing', async () => {
    const { shopifyCartHandler } = loadHandlerWithMockedShopify(CART_PATH, {
      createCart: async () => {
        throw new Error('SHOPIFY_STORE_DOMAIN/SHOPIFY_STOREFRONT_ACCESS_TOKEN not configured');
      },
    });
    const body = { lines: [{ variantId: 'gid://shopify/ProductVariant/101', quantity: 1 }] };
    const res = await shopifyCartHandler(fakeRequest(body), fakeContext());
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.jsonBody.code, 'not_configured');
  });

  await test('cart handler returns 400 with userErrors when Shopify rejects the cart (e.g. out-of-stock variant)', async () => {
    const { shopifyCartHandler } = loadHandlerWithMockedShopify(CART_PATH, {
      createCart: async () => {
        const err = new Error('Shopify rejected the cart: Variant is out of stock');
        err.userErrors = [{ field: ['lines'], message: 'Variant is out of stock' }];
        throw err;
      },
    });
    const body = { lines: [{ variantId: 'gid://shopify/ProductVariant/999', quantity: 1 }] };
    const res = await shopifyCartHandler(fakeRequest(body), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.jsonBody.code, 'shopify_user_error');
  });

  await test('cart handler returns 502 on a generic upstream failure', async () => {
    const { shopifyCartHandler } = loadHandlerWithMockedShopify(CART_PATH, {
      createCart: async () => {
        throw new Error('Shopify Storefront API request failed: 500 Internal Server Error');
      },
    });
    const body = { lines: [{ variantId: 'gid://shopify/ProductVariant/101', quantity: 1 }] };
    const res = await shopifyCartHandler(fakeRequest(body), fakeContext());
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.jsonBody.code, 'upstream_error');
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
