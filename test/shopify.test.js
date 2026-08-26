// Mocked-fetch unit tests for lib/shopify.js (no live Shopify store/credentials required). Mirrors the
// mocking style of test/openai.test.js -- a fake fetch captures the outgoing request and returns a
// canned Storefront API response shape, verified against the current (2026-07) Storefront API docs
// this was built against (see lib/shopify.js's header comment).
//
// Run with: node test/shopify.test.js
'use strict';

const assert = require('assert');
const { getProducts, createCart, mapProductNode } = require('../lib/shopify');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A realistic Storefront API `products` response shape, matching the exact field names verified live
// against https://shopify.dev/docs/api/storefront/latest/objects/Product and .../ProductVariant
// (title/description/productType/tags/featuredImage/variants.edges.node.price{amount,currencyCode}).
function fakeProductsResponse(nodes) {
  return { data: { products: { edges: nodes.map((node) => ({ node })) } } };
}

const SILK_STRAIGHT_NODE = {
  id: 'gid://shopify/Product/1',
  title: 'Silk Straight 24"',
  handle: 'silk-straight-24',
  description: 'HD lace, natural black, glueless install.',
  productType: 'Wig',
  tags: ['Bestseller', 'HD Lace'],
  availableForSale: true,
  featuredImage: { url: 'https://cdn.shopify.com/silk-straight.jpg', altText: 'Silk Straight 24"' },
  variants: {
    edges: [
      {
        node: {
          id: 'gid://shopify/ProductVariant/101',
          availableForSale: true,
          price: { amount: '320.00', currencyCode: 'USD' },
        },
      },
    ],
  },
};

const SOLD_OUT_NODE = {
  id: 'gid://shopify/Product/2',
  title: 'Sold Out Unit',
  handle: 'sold-out-unit',
  description: '',
  productType: 'Wig',
  tags: [],
  availableForSale: false,
  featuredImage: null,
  variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/202', availableForSale: false, price: { amount: '99.00', currencyCode: 'USD' } } }] },
};

// No purchasable variant at all -- e.g. a draft/unpublished product with zero variants returned.
const NO_VARIANT_NODE = {
  id: 'gid://shopify/Product/3',
  title: 'No Variant Product',
  handle: 'no-variant',
  description: '',
  productType: '',
  tags: [],
  availableForSale: false,
  featuredImage: null,
  variants: { edges: [] },
};

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
    for (const k of Object.keys(envOverrides)) {
      prev[k] = process.env[k];
      process.env[k] = envOverrides[k];
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(envOverrides)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  await test('mapProductNode maps a real-shaped Product node into the card shape index.html expects', () => {
    const mapped = mapProductNode(SILK_STRAIGHT_NODE);
    assert.strictEqual(mapped.n, 'Silk Straight 24"');
    assert.strictEqual(mapped.m, 'Wig');
    assert.strictEqual(mapped.p, 320);
    assert.strictEqual(mapped.currency, 'USD');
    assert.strictEqual(mapped.img, 'https://cdn.shopify.com/silk-straight.jpg');
    assert.strictEqual(mapped.tag, 'Bestseller');
    assert.strictEqual(mapped.variantId, 'gid://shopify/ProductVariant/101');
    assert.strictEqual(mapped.availableForSale, true);
  });

  await test('mapProductNode falls back to tags for meta text when productType is empty, and handles no featuredImage', () => {
    const mapped = mapProductNode(SOLD_OUT_NODE);
    assert.strictEqual(mapped.img, null);
    assert.strictEqual(mapped.tag, '');
    assert.strictEqual(mapped.availableForSale, false);
  });

  await test('getProducts throws a clear error when Shopify env vars are not configured', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: '', SHOPIFY_STOREFRONT_ACCESS_TOKEN: '' }, async () => {
      await assert.rejects(() => getProducts({ _fetch: async () => jsonResponse(200, {}) }), /not configured/);
    });
  });

  await test('getProducts builds the expected Storefront GraphQL request (URL, header, body)', async () => {
    await withEnv(
      { SHOPIFY_STORE_DOMAIN: 'afrikanadollz.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'test-token', SHOPIFY_API_VERSION: '2026-07' },
      async () => {
        let capturedUrl, capturedOptions;
        const fakeFetch = async (url, options) => {
          capturedUrl = url;
          capturedOptions = options;
          return jsonResponse(200, fakeProductsResponse([SILK_STRAIGHT_NODE]));
        };
        await getProducts({ first: 24, _fetch: fakeFetch });

        assert.strictEqual(capturedUrl, 'https://afrikanadollz.myshopify.com/api/2026-07/graphql.json');
        assert.strictEqual(capturedOptions.method, 'POST');
        assert.strictEqual(capturedOptions.headers['X-Shopify-Storefront-Access-Token'], 'test-token');
        assert.strictEqual(capturedOptions.headers['Content-Type'], 'application/json');
        const sentBody = JSON.parse(capturedOptions.body);
        assert.ok(/query StorefrontProducts/.test(sentBody.query));
        assert.strictEqual(sentBody.variables.first, 24);
      }
    );
  });

  await test('getProducts strips out products with no purchasable variant (no variantId / no price)', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 't' }, async () => {
      const fakeFetch = async () => jsonResponse(200, fakeProductsResponse([SILK_STRAIGHT_NODE, NO_VARIANT_NODE]));
      const products = await getProducts({ _fetch: fakeFetch });
      assert.deepStrictEqual(
        products.map((p) => p.n),
        ['Silk Straight 24"']
      );
    });
  });

  await test('getProducts throws when Shopify returns GraphQL errors', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 't' }, async () => {
      const fakeFetch = async () => jsonResponse(200, { errors: [{ message: 'Invalid Storefront Access Token' }] });
      await assert.rejects(() => getProducts({ _fetch: fakeFetch }), /Invalid Storefront Access Token/);
    });
  });

  await test('getProducts throws when the HTTP response is not ok', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 't' }, async () => {
      const fakeFetch = async () => jsonResponse(401, { errors: 'unauthorized' });
      await assert.rejects(() => getProducts({ _fetch: fakeFetch }), /401/);
    });
  });

  await test('createCart throws on an empty lines array without making a request', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 't' }, async () => {
      let called = false;
      const fakeFetch = async () => {
        called = true;
        return jsonResponse(200, {});
      };
      await assert.rejects(() => createCart({ lines: [], _fetch: fakeFetch }), /non-empty lines/);
      assert.strictEqual(called, false);
    });
  });

  await test('createCart maps {variantId, quantity} lines to merchandiseId and returns checkoutUrl', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 't' }, async () => {
      let capturedBody;
      const fakeFetch = async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return jsonResponse(200, {
          data: {
            cartCreate: {
              cart: { id: 'gid://shopify/Cart/abc123', checkoutUrl: 'https://x.myshopify.com/cart/c/abc123' },
              userErrors: [],
            },
          },
        });
      };
      const result = await createCart({
        lines: [{ variantId: 'gid://shopify/ProductVariant/101', quantity: 2 }],
        _fetch: fakeFetch,
      });

      assert.deepStrictEqual(capturedBody.variables.lines, [{ merchandiseId: 'gid://shopify/ProductVariant/101', quantity: 2 }]);
      assert.strictEqual(result.cartId, 'gid://shopify/Cart/abc123');
      assert.strictEqual(result.checkoutUrl, 'https://x.myshopify.com/cart/c/abc123');
    });
  });

  await test('createCart throws (with userErrors attached) when Shopify rejects the cart, e.g. out-of-stock variant', async () => {
    await withEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_STOREFRONT_ACCESS_TOKEN: 't' }, async () => {
      const fakeFetch = async () =>
        jsonResponse(200, {
          data: {
            cartCreate: {
              cart: null,
              userErrors: [{ field: ['lines', '0', 'merchandiseId'], message: 'Variant is out of stock' }],
            },
          },
        });
      await assert.rejects(
        () => createCart({ lines: [{ variantId: 'gid://shopify/ProductVariant/999', quantity: 1 }], _fetch: fakeFetch }),
        (err) => {
          assert.ok(/out of stock/.test(err.message));
          assert.ok(Array.isArray(err.userErrors) && err.userErrors.length === 1);
          return true;
        }
      );
    });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
