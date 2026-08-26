// POST /api/account/billing/pay — the logged-in customer's "Pay balance" action from account.html's
// billing ledger. Body: `{appointmentId}`. Creates a Stripe PaymentIntent for whatever's left owed on
// that appointment and hands the client its clientSecret to complete via Stripe.js Elements
// (stripe.confirmPayment()) in the browser.
//
// This handler's ONLY job is to create the PaymentIntent with the right amount/metadata — it never
// writes a billing_entries row itself. src/functions/payments/webhook.js is the one durable recorder:
// once Stripe confirms the payment_intent.succeeded event, the webhook reads metadata.appointmentId
// off the intent, looks up the appointment's customer_id, and inserts the billing_entries row
// (idempotently, via the partial unique index on external_ref). Two independent recorders racing on
// the same payment is exactly the bug that architecture avoids — see webhook.js's header comment.
//
// IDOR: appointmentId is client-supplied and MUST be verified to belong to auth.customerId (the
// verified session's own id, never trusted from the body) before anything is computed from it. Same
// pattern as every other /api/account/* handler in this folder (appointments.js, billing.js): the
// ownership check lives directly in the SQL WHERE clause, so "appointment doesn't exist" and
// "appointment belongs to someone else" are indistinguishable from the response (both an empty result
// set → 404), which is exactly what you want — this endpoint can't be used to probe whether some
// other customer's appointment id exists.
//
// remainingCents = that appointment's service price_cents minus the sum of amount_cents already
// recorded against it in billing_entries, across ALL sources/methods (manual entries Diaka typed in
// admin.html AND any prior 'stripe' entries the webhook already recorded) — a customer who's already
// paid in full (or overpaid) gets a clean 400, not a $0-or-negative PaymentIntent (Stripe would reject
// a non-positive amount anyway; lib/stripe.js's createPaymentIntent throws on it, but the point here
// is to give the caller a clear, expected 400 rather than a 500 from that guard tripping).
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireCustomer } = require('../../../lib/customerAuth');
const { isConfigured, createPaymentIntent } = require('../../../lib/stripe');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function accountBillingPayHandler(request, context) {
  const auth = requireCustomer(request);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  // Fail fast, before touching the DB, when Stripe isn't set up yet (expected during development —
  // see lib/stripe.js's header comment on the placeholder env vars). Same shape as
  // src/functions/payments/config.js's 503 so the frontend can branch on `code` identically.
  if (!isConfigured()) {
    return { status: 503, jsonBody: { error: 'Card payments are not configured yet.', code: 'not_configured' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const rawId = body && body.appointmentId;
  const appointmentId = Number.isInteger(Number(rawId)) && Number(rawId) > 0 ? Number(rawId) : null;
  if (!appointmentId) {
    return { status: 400, jsonBody: { error: 'appointmentId is required' } };
  }

  try {
    const db = getPool();
    const { rows: apptRows } = await db.query(
      `SELECT a.id, s.price_cents
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.id = $1 AND a.customer_id = $2`,
      [appointmentId, auth.customerId]
    );
    if (apptRows.length === 0) {
      return { status: 404, jsonBody: { error: 'Appointment not found.' } };
    }
    const priceCents = apptRows[0].price_cents;
    if (priceCents === null || priceCents === undefined) {
      return { status: 400, jsonBody: { error: "This appointment's service has no price set." } };
    }

    const { rows: paidRows } = await db.query(
      'SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM billing_entries WHERE appointment_id = $1',
      [appointmentId]
    );
    const paidSoFar = Number(paidRows[0].paid);
    const remainingCents = Number(priceCents) - paidSoFar;

    if (remainingCents <= 0) {
      return { status: 400, jsonBody: { error: 'Nothing owed on this appointment' } };
    }

    const intent = await createPaymentIntent({
      amountCents: remainingCents,
      currency: 'usd',
      metadata: {
        purpose: 'balance',
        appointmentId: String(appointmentId),
        customerId: String(auth.customerId),
      },
      description: 'AFRIKANADOLLZ balance payment',
    });

    return { status: 200, jsonBody: { clientSecret: intent.clientSecret, amountCents: remainingCents } };
  } catch (err) {
    context.error('POST /api/account/billing/pay failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('accountBillingPay', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'account/billing/pay',
  handler: accountBillingPayHandler,
});

module.exports = { accountBillingPayHandler };
