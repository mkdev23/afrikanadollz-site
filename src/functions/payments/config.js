// GET /api/payments/config — hands the frontend the Stripe *publishable* key (never the secret key)
// so book.html/account.html can construct Stripe.js/Elements without hardcoding it into static HTML.
// Same rationale as src/functions/shopify's backend-proxy pattern (see lib/shopify.js's header
// comment): this is a no-build-step static site, so there's nowhere to inject an env var into HTML at
// deploy time — every piece of external config this app needs client-side goes through a small
// same-origin endpoint like this one instead. The publishable key isn't a secret (Stripe's own docs
// say so explicitly — it's meant to be embedded in client-side code), so serving it plainly here is
// fine; STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET never appear in any response from this app.
// Public/anonymous on purpose — a customer needs this before they've booked or logged in at all.
'use strict';

const { app } = require('@azure/functions');

function isRealValue(v) {
  return !!v && !v.startsWith('REPLACE_ME');
}

async function paymentsConfigHandler(request, context) {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!isRealValue(key)) {
    return { status: 503, jsonBody: { error: 'Card payments are not configured yet.', code: 'not_configured' } };
  }
  return { status: 200, jsonBody: { publishableKey: key } };
}

app.http('paymentsConfig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'payments/config',
  handler: paymentsConfigHandler,
});

module.exports = { paymentsConfigHandler };
