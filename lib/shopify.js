// Thin wrapper around Shopify's Storefront API (GraphQL) -- used by src/functions/shopify/products.js
// and src/functions/shopify/cart.js. Kept separate from the HTTP layer so it can be unit-tested with a
// mocked fetch, same spirit as lib/openai.js being unit-tested with a mocked fetch (see test/openai.test.js)
// and lib/email.js/lib/sms.js being unit-tested with a mocked ACS SDK client.
//
// Uses Node 20's built-in global fetch rather than Shopify's official JS Buy SDK -- this project
// deliberately keeps its Azure Functions app's dependency footprint small (see package.json: just pg +
// @azure/functions + the two ACS SDKs), and the Storefront API is a small, stable GraphQL surface that a
// plain fetch()+JSON.stringify() handles fine with no SDK needed.
//
// Why a backend proxy instead of the browser calling Shopify directly: Shopify's Storefront API is
// explicitly designed to support direct-from-browser calls (a "Public access" Storefront token, CORS-
// enabled -- see https://shopify.dev/docs/api/storefront#authentication), and that IS the pattern
// Shopify's own docs recommend for a headless storefront. This project chose a thin backend proxy
// instead, for two repo-specific reasons rather than a security requirement: (1) this is a
// no-build-step static site -- there is nowhere to inject an env var into index.html at deploy time, so
// the store domain + token would otherwise have to be hardcoded directly into committed HTML/JS, whereas
// every other piece of this app's external config lives in local.settings.json / infra/main.bicep
// app settings (see DATABASE_URL, AZURE_OPENAI_*, ACS_* for the established pattern); (2) proxying
// through our own Function App lets a single place decide what "Shopify is unreachable" means and return
// a clean error shape the frontend can key its fallback UI off of, rather than the frontend having to
// interpret raw Shopify GraphQL error shapes itself.
//
// PLACEHOLDER env vars -- filled in for real once the user creates a Storefront API access token in the
// Shopify admin (Sales channels -> Headless -> create a storefront -> reveal the Storefront API access
// token) for the store that already lives at afrikanadollz.com:
//   SHOPIFY_STORE_DOMAIN              - e.g. afrikanadollz.myshopify.com (the *.myshopify.com domain,
//                                        NOT the custom afrikanadollz.com domain -- the Storefront API
//                                        is always addressed via the myshopify.com hostname)
//   SHOPIFY_STOREFRONT_ACCESS_TOKEN   - the Storefront API access token from that same Headless channel
//                                        screen (this is a PUBLIC token, meant to be used outside a
//                                        trusted backend -- see the comment above -- but is still kept
//                                        as a server-side env var here to match this repo's config
//                                        convention rather than hardcoding it into index.html)
//   SHOPIFY_API_VERSION               - Storefront API version, e.g. "2026-07" (Shopify ships a new
//                                        version quarterly; this defaults to a real, current version
//                                        below so the app doesn't crash on cold start if unset, but the
//                                        user should keep this current -- see
//                                        https://shopify.dev/docs/api/usage/versioning)
'use strict';

// Current as of Aug 2026 (https://shopify.dev/docs/api/storefront/latest) -- verified live against
// Shopify's docs, not carried over from training data, since the Storefront API versions quarterly.
const DEFAULT_API_VERSION = '2026-07';

const PRODUCTS_QUERY = `
  query StorefrontProducts($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          title
          handle
          description
          productType
          tags
          availableForSale
          featuredImage {
            url
            altText
          }
          variants(first: 1) {
            edges {
              node {
                id
                availableForSale
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CART_CREATE_MUTATION = `
  mutation CartCreate($lines: [CartLineInput!]!) {
    cartCreate(input: { lines: $lines }) {
      cart {
        id
        checkoutUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function getConfig() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  if (!domain || !token) {
    throw new Error('SHOPIFY_STORE_DOMAIN/SHOPIFY_STOREFRONT_ACCESS_TOKEN not configured');
  }
  return { domain: domain.replace(/^https?:\/\//, '').replace(/\/+$/, ''), token, apiVersion };
}

/**
 * POST a GraphQL request to the Storefront API.
 * @param {string} query
 * @param {object} variables
 * @param {Function} [_fetch] - test-only override for the fetch implementation.
 */
async function shopifyGraphQL(query, variables, _fetch) {
  const { domain, token, apiVersion } = getConfig();
  const url = `https://${domain}/api/${apiVersion}/graphql.json`;

  const doFetch = _fetch || fetch;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify Storefront API request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Shopify Storefront API returned GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

/**
 * Map a raw Storefront API Product node into the flat shape index.html's product cards expect
 * ({n, m, p, img, tag, variantId, ...}), mirroring the existing hardcoded PRODUCTS array shape in
 * index.html as closely as real Shopify data allows.
 *
 * Simplification, called out explicitly (see the report this was built against): index.html's card
 * layout has no variant/option picker, so each product is represented by its FIRST available variant
 * only -- same simplification the Shopify Buy Button widget makes by default. A store with meaningfully
 * different prices per variant (e.g. length-based pricing) would need a real picker to represent that
 * correctly; that's a follow-up, not something this pass silently gets wrong, since the price/variantId
 * shown is always a real, purchasable variant of that product.
 */
function mapProductNode(node) {
  const variantEdge = node.variants && node.variants.edges && node.variants.edges[0];
  const variant = variantEdge && variantEdge.node;
  const priceAmount = variant && variant.price ? Number(variant.price.amount) : null;

  return {
    id: node.id,
    n: node.title,
    m: node.productType || (node.tags && node.tags.length ? node.tags.slice(0, 2).join(' · ') : ''),
    p: priceAmount,
    currency: variant && variant.price ? variant.price.currencyCode : 'USD',
    img: node.featuredImage ? node.featuredImage.url : null,
    tag: node.tags && node.tags.length ? node.tags[0] : '',
    handle: node.handle,
    variantId: variant ? variant.id : null,
    availableForSale: Boolean(node.availableForSale && (!variant || variant.availableForSale)),
  };
}

/**
 * Fetch up to `first` products from the connected Shopify store's Storefront API.
 * @param {object} [params]
 * @param {number} [params.first]
 * @param {Function} [params._fetch] - test-only fetch override.
 * @returns {Promise<Array>} mapped product objects (see mapProductNode)
 */
async function getProducts({ first = 24, _fetch } = {}) {
  const data = await shopifyGraphQL(PRODUCTS_QUERY, { first }, _fetch);
  const edges = (data && data.products && data.products.edges) || [];
  return edges.map((e) => mapProductNode(e.node)).filter((p) => p.variantId && p.p !== null);
}

/**
 * Create a real Shopify cart from {variantId, quantity} lines and return its hosted checkout URL.
 * @param {object} params
 * @param {Array<{variantId:string, quantity:number}>} params.lines
 * @param {Function} [params._fetch] - test-only fetch override.
 * @returns {Promise<{cartId:string, checkoutUrl:string}>}
 */
async function createCart({ lines, _fetch }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('createCart requires a non-empty lines array');
  }
  const graphqlLines = lines.map((l) => ({ merchandiseId: l.variantId, quantity: l.quantity }));

  const data = await shopifyGraphQL(CART_CREATE_MUTATION, { lines: graphqlLines }, _fetch);
  const result = data && data.cartCreate;
  if (!result) {
    throw new Error('Shopify Storefront API returned no cartCreate result');
  }
  if (result.userErrors && result.userErrors.length) {
    const err = new Error(`Shopify rejected the cart: ${result.userErrors.map((e) => e.message).join('; ')}`);
    err.userErrors = result.userErrors;
    throw err;
  }
  if (!result.cart || !result.cart.checkoutUrl) {
    throw new Error('Shopify Storefront API did not return a checkoutUrl');
  }
  return { cartId: result.cart.id, checkoutUrl: result.cart.checkoutUrl };
}

module.exports = { getProducts, createCart, mapProductNode, shopifyGraphQL, DEFAULT_API_VERSION };
