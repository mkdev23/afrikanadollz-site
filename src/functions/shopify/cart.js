// POST /api/shopify/cart -- takes the site's local bag/cart contents at checkout time, creates a REAL
// Shopify cart via the Storefront API (cartCreate), and returns its hosted checkoutUrl so the frontend
// can redirect the customer to Shopify's own checkout. This does NOT rebuild checkout -- Shopify's
// checkout stays hosted on Shopify's own domain, exactly as intended; this endpoint's whole job is
// getting a customer from "browsing on our site" to "a working Shopify checkout with the right items in
// their cart."
//
// Body: { lines: [{ variantId: "gid://shopify/ProductVariant/...", quantity: 1 }, ...] }
// Success: 200 { checkoutUrl, cartId }
// Validation failure (bad shape, or Shopify's own userErrors e.g. an out-of-stock variant): 400
// Shopify not configured yet: 503. Network/GraphQL failure: 502.
//
// Ported to this repo's Azure Functions Node.js v4 programming model, same request-validation +
// try/catch-to-status-code shape as src/functions/styleSuggest.js.
'use strict';

const { app } = require('@azure/functions');
const { createCart } = require('../../../lib/shopify');

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be JSON'];

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    errors.push('lines is required and must be a non-empty array of {variantId, quantity}');
  } else {
    for (const line of body.lines) {
      if (!line || typeof line.variantId !== 'string' || !line.variantId.startsWith('gid://shopify/ProductVariant/')) {
        errors.push('each line must have a variantId string beginning with gid://shopify/ProductVariant/');
        break;
      }
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 250) {
        errors.push('each line must have an integer quantity between 1 and 250');
        break;
      }
    }
  }

  return errors;
}

async function shopifyCartHandler(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const errors = validateBody(body);
  if (errors.length) {
    return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };
  }

  try {
    const { cartId, checkoutUrl } = await createCart({
      lines: body.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    });
    return { status: 200, jsonBody: { cartId, checkoutUrl } };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/not configured/.test(message)) {
      context.warn('POST /api/shopify/cart: Shopify is not configured yet:', message);
      return { status: 503, jsonBody: { error: 'Shopify is not configured yet', code: 'not_configured' } };
    }
    if (err && err.userErrors) {
      return { status: 400, jsonBody: { error: message, code: 'shopify_user_error', userErrors: err.userErrors } };
    }
    context.error('POST /api/shopify/cart failed:', message);
    return { status: 502, jsonBody: { error: 'Could not reach Shopify checkout right now', code: 'upstream_error' } };
  }
}

app.http('shopifyCart', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'shopify/cart',
  handler: shopifyCartHandler,
});

module.exports = { shopifyCartHandler, validateBody };
