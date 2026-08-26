// POST /api/payments/deposit-intent — creates a Stripe PaymentIntent for the $20 booking deposit, so
// book.html can optionally offer "pay the deposit by card now" alongside the existing Cash App path.
// Public/anonymous on purpose, matching src/functions/book.js's own auth level — a guest hasn't
// booked or logged in yet at this point in the flow, and this must be callable before an appointment
// exists (see lib/stripe.js's createPaymentIntent comment on why a deposit's metadata has no
// appointmentId yet).
//
// DEPOSIT_AMOUNT_CENTS is the ONE source of truth for the deposit amount — src/functions/book.js
// imports it from here rather than redefining it, so the amount POST /api/book verifies a payment
// against can never drift from the amount this endpoint actually charges. $20, matching the deposit
// amount already published in help.html's Booking & Deposits section and book.html's terms modal —
// this is not a place to invent a different number.
//
// The amount is entirely server-decided: `serviceId` in the request body (if present) is used ONLY
// for the PaymentIntent's description/metadata (so it's traceable in the Stripe Dashboard / a future
// reconciliation pass) — it never influences amountCents. The deposit is a flat fee regardless of
// which service was picked.
'use strict';

const { app } = require('@azure/functions');
const { isConfigured, createPaymentIntent } = require('../../../lib/stripe');

const DEPOSIT_AMOUNT_CENTS = 2000; // $20 — see help.html's Booking & Deposits section / book.html's terms modal

async function depositIntentHandler(request, context) {
  if (!isConfigured()) {
    // Expected, not an error condition: real Stripe keys haven't been provided by the business owner
    // yet. book.html must treat this as "skip the card-payment step entirely, use the existing
    // Cash-App-only flow" — see src/functions/payments/config.js for the identical contract.
    return { status: 503, jsonBody: { error: 'Card payments are not configured yet.', code: 'not_configured' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const serviceId = body && body.serviceId != null ? String(body.serviceId) : '';

  try {
    const intent = await createPaymentIntent({
      amountCents: DEPOSIT_AMOUNT_CENTS,
      currency: 'usd',
      metadata: { purpose: 'deposit', serviceId },
      description: 'AFRIKANADOLLZ appointment deposit',
    });
    return {
      status: 200,
      jsonBody: { clientSecret: intent.clientSecret, paymentIntentId: intent.id, amountCents: DEPOSIT_AMOUNT_CENTS },
    };
  } catch (err) {
    context.error('POST /api/payments/deposit-intent failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('paymentsDepositIntent', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'payments/deposit-intent',
  handler: depositIntentHandler,
});

module.exports = { depositIntentHandler, DEPOSIT_AMOUNT_CENTS };
