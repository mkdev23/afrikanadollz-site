// GET /api/shopify/products -- proxies the connected Shopify store's Storefront API (see lib/shopify.js
// for why this goes through a backend proxy rather than a direct browser call) so index.html's #products
// section can render real inventory instead of the hardcoded PRODUCTS array.
//
// Ported to this repo's Azure Functions Node.js v4 programming model, same conventions as
// src/functions/services.js: a thin handler that calls a lib/*.js function and maps outcomes to
// status codes, and a non-GET request gets Azure's own 404 (no route registered for that method)
// rather than an explicit 405 body.
//
// Response shape on success: { products: [{ id, n, m, p, currency, img, tag, handle, variantId,
// availableForSale }, ...] } -- deliberately using the same short field names (n/m/p/img/tag) as
// index.html's existing PRODUCTS array, so the frontend can treat a real Shopify product and a fallback
// static product identically wherever possible.
//
// If SHOPIFY_STORE_DOMAIN/SHOPIFY_STOREFRONT_ACCESS_TOKEN aren't configured yet (true until the user
// creates a Storefront API token in their Shopify admin), this returns 503 with a clear error code the
// frontend can distinguish from a transient failure -- see index.html's loadProducts(), which falls back
// to the static demo catalogue either way but this makes the distinction visible in logs/devtools.
'use strict';

const { app } = require('@azure/functions');
const { getProducts } = require('../../../lib/shopify');

async function shopifyProductsHandler(request, context) {
  try {
    const products = await getProducts({ first: 24 });
    return { status: 200, jsonBody: { products } };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/not configured/.test(message)) {
      context.warn('GET /api/shopify/products: Shopify is not configured yet:', message);
      return { status: 503, jsonBody: { error: 'Shopify is not configured yet', code: 'not_configured' } };
    }
    context.error('GET /api/shopify/products failed:', message);
    return { status: 502, jsonBody: { error: 'Could not reach Shopify right now', code: 'upstream_error' } };
  }
}

app.http('shopifyProducts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'shopify/products',
  handler: shopifyProductsHandler,
});

module.exports = { shopifyProductsHandler };
