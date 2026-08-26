// Thin wrapper around the official `stripe` npm SDK -- used by src/functions/book.js,
// src/functions/payments/*.js, and src/functions/admin/billing.js for service-appointment card
// payments (deposits at booking time, balance payments from account.html, staff-generated Payment
// Links as the v1 admin-initiated-charge fallback -- see the plan this was built against).
//
// Unlike lib/shopify.js (plain fetch, no SDK -- see that file's header comment for why), this uses
// Stripe's own SDK rather than hand-rolling raw HTTP calls, for one specific reason that isn't
// optional: webhook *signature verification* (constructWebhookEvent below) has to be exactly right
// or it's not a security control at all, and Stripe's SDK is the maintained, audited implementation
// of that check (HMAC-SHA256 over the raw body with timestamp-tolerance replay protection) -- rolling
// it by hand here would be the kind of "looks fine, subtly wrong" code this project has otherwise
// avoided (see lib/adminAuth.js's insistence on crypto.timingSafeEqual everywhere). The rest of this
// file (PaymentIntents, Payment Links) could have been plain fetch like lib/shopify.js, but using the
// SDK throughout keeps one dependency and one calling convention instead of mixing two styles.
//
// Card data never reaches this backend or this file: the client always collects card details via
// Stripe.js/Elements (hosted, tokenized) and only ever hands this backend a PaymentIntent id — see
// createPaymentIntent()'s clientSecret (consumed by Stripe.js in the browser) and
// verifyPaymentSucceeded() (this backend's only source of truth for "did it actually succeed", never
// a client-supplied boolean). This keeps the app PCI-SAQ-A eligible, same principle as the Shopify
// integration's hosted-checkout handoff.
//
// PLACEHOLDER env vars -- filled in for real once the user creates a Stripe account (test-mode keys
// are fine to build/verify against first, same pattern as every other external service this project
// integrates with):
//   STRIPE_SECRET_KEY        - sk_test_... or sk_live_..., from the Stripe Dashboard's API keys page.
//                               Server-side only, never sent to the browser.
//   STRIPE_PUBLISHABLE_KEY   - pk_test_... or pk_live_..., safe to expose to the browser (Stripe.js
//                               needs it client-side) -- served to the frontend via
//                               src/functions/payments/config.js rather than hardcoded into HTML,
//                               matching this repo's "no secrets baked into static files" convention
//                               even though this particular value isn't secret.
//   STRIPE_WEBHOOK_SECRET    - whsec_..., generated when the webhook endpoint
//                               (https://<function-app>/api/payments/webhook, or the SWA-proxied
//                               .../api/payments/webhook) is registered in the Stripe Dashboard's
//                               Webhooks page. Required only for constructWebhookEvent below.
'use strict';

const Stripe = require('stripe');

let client;
/**
 * Lazily construct the singleton Stripe client from STRIPE_SECRET_KEY. Every exported function below
 * takes an optional trailing `client` param (defaulting to this) so tests can inject a mock without
 * needing a real API key or network access -- same "test-only override" shape as lib/shopify.js's
 * `_fetch` param.
 */
function getClient() {
  if (!client) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
    client = new Stripe(secretKey, { apiVersion: '2024-12-18.acacia' });
  }
  return client;
}

/** True if STRIPE_SECRET_KEY looks like a real key rather than the shipped REPLACE_ME_ placeholder. */
function isConfigured() {
  const key = process.env.STRIPE_SECRET_KEY;
  return !!key && !key.startsWith('REPLACE_ME');
}

/**
 * Create a PaymentIntent for a service payment (a booking deposit or a balance payment).
 * `metadata` is how the webhook (src/functions/payments/webhook.js) and any later reconciliation
 * resolve *which* appointment/customer a payment belongs to without a separate pending-intents table
 * -- always pass at least `{ purpose: 'deposit' | 'balance', appointmentId? }` (appointmentId is
 * omitted for a booking deposit, since the appointment doesn't exist yet at the moment the deposit is
 * collected -- see src/functions/book.js, which creates the appointment and the PaymentIntent's
 * corresponding billing_entries row in the same transaction once payment is verified).
 * @param {{amountCents:number, currency?:string, metadata:object, description?:string}} params
 * @param {import('stripe').Stripe} [_client]
 * @returns {Promise<{id:string, clientSecret:string, status:string}>}
 */
async function createPaymentIntent({ amountCents, currency = 'usd', metadata, description }, _client) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('createPaymentIntent: amountCents must be a positive integer');
  }
  const stripe = _client || getClient();
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    metadata: metadata || {},
    description,
    automatic_payment_methods: { enabled: true },
  });
  return { id: intent.id, clientSecret: intent.client_secret, status: intent.status };
}

/**
 * Re-fetch a PaymentIntent directly from Stripe's API -- the only trustworthy source for "did this
 * actually succeed". Every caller that's about to record a payment (src/functions/book.js,
 * src/functions/account/billing.js) must call this (via verifyPaymentSucceeded below, not this
 * directly, in the common case) rather than trusting anything the client reports about its own
 * payment attempt.
 * @param {string} paymentIntentId
 * @param {import('stripe').Stripe} [_client]
 */
async function retrievePaymentIntent(paymentIntentId, _client) {
  const stripe = _client || getClient();
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * The actual trust boundary: confirms a PaymentIntent both succeeded AND matches the amount/currency
 * the server independently expects for this booking/balance -- not just "some payment somewhere
 * succeeded". Without the amount check, a client could pay a 1-cent PaymentIntent and claim it covers
 * a $20 deposit. Returns the verified PaymentIntent on success; throws a descriptive Error otherwise
 * so callers can turn that into a clean 402/400 response rather than silently proceeding.
 * @param {string} paymentIntentId
 * @param {{expectedAmountCents:number, expectedCurrency?:string}} expectations
 * @param {import('stripe').Stripe} [_client]
 */
async function verifyPaymentSucceeded(paymentIntentId, { expectedAmountCents, expectedCurrency = 'usd' }, _client) {
  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    throw new Error('verifyPaymentSucceeded: paymentIntentId is required');
  }
  const intent = await retrievePaymentIntent(paymentIntentId, _client);
  if (intent.status !== 'succeeded') {
    throw new Error(`verifyPaymentSucceeded: PaymentIntent status is '${intent.status}', not 'succeeded'`);
  }
  if (intent.amount !== expectedAmountCents || intent.currency !== expectedCurrency) {
    throw new Error(
      `verifyPaymentSucceeded: amount/currency mismatch (expected ${expectedAmountCents} ${expectedCurrency}, got ${intent.amount} ${intent.currency})`
    );
  }
  return intent;
}

/**
 * Create a Stripe-hosted Payment Link for the v1 staff-initiated-charge flow (admin.html's
 * per-appointment Payment panel): rather than building custom card-entry UI into admin.html (which
 * would pull raw-PAN-adjacent UI into a page this project otherwise keeps entirely out of PCI scope),
 * staff generate a link here and send it to the customer (text/email, off-app) to pay off-app on
 * Stripe's own hosted page; the webhook records the resulting billing_entries row once it completes.
 * Payment Links require a Price object rather than an ad-hoc amount, so this creates a fresh
 * single-use Price first (Stripe has no cost/limit concern with one-off Prices like this).
 * @param {{amountCents:number, currency?:string, description:string, metadata:object}} params
 * @param {import('stripe').Stripe} [_client]
 * @returns {Promise<{id:string, url:string}>}
 */
async function createPaymentLink({ amountCents, currency = 'usd', description, metadata }, _client) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('createPaymentLink: amountCents must be a positive integer');
  }
  const stripe = _client || getClient();
  const price = await stripe.prices.create({
    unit_amount: amountCents,
    currency,
    product_data: { name: description || 'AFRIKANADOLLZ appointment balance' },
  });
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: metadata || {},
  });
  return { id: link.id, url: link.url };
}

/**
 * Verify and parse a raw incoming webhook request (src/functions/payments/webhook.js) into a real
 * Stripe event object. Throws on any signature mismatch/replay/malformed input -- callers must treat
 * a throw as "reject this request", never fall back to trusting the unparsed body.
 * @param {string|Buffer} rawBody - the *raw*, unparsed request body (signature is computed over the
 *   exact bytes Stripe sent; JSON.parse-then-stringify would not reproduce the same signature).
 * @param {string} signatureHeader - the `stripe-signature` request header, verbatim.
 * @param {import('stripe').Stripe} [_client]
 */
function constructWebhookEvent(rawBody, signatureHeader, _client) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  const stripe = _client || getClient();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

module.exports = {
  isConfigured,
  createPaymentIntent,
  retrievePaymentIntent,
  verifyPaymentSucceeded,
  createPaymentLink,
  constructWebhookEvent,
};
