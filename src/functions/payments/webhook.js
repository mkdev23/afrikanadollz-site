// POST /api/payments/webhook — Stripe's durable, async source of truth for payment events. Two
// booking-time card flows (src/functions/book.js's deposit, src/functions/account/billing.js's
// balance payment) already synchronously verify+record the payment inline, so for those this webhook
// is mostly a safety net (see below). It's the *only* mechanism that records a payment made through a
// staff-generated Payment Link (src/functions/admin/billing.js's "charge card" v1 fallback — see
// lib/stripe.js's createPaymentLink comment), since nothing else ever calls this app back for that
// flow — the customer pays entirely on Stripe's hosted page.
//
// Not behind requireAdmin()/requireCustomer() — Stripe itself is the caller, authenticated instead by
// verifying the `stripe-signature` header against STRIPE_WEBHOOK_SECRET (see
// lib/stripe.js's constructWebhookEvent). This is the standard, required pattern for any Stripe
// webhook; treat a signature failure as untrusted input, always reject with 400 rather than process it.
//
// Idempotency: Stripe redelivers events (its own retry policy, or plain duplicate delivery) — every
// insert here relies on the partial unique index on billing_entries(external_ref) (see
// db/schema.sql), catching the resulting unique-violation as "already recorded" rather than a real
// error. Only ever inserts when the event's PaymentIntent carries `metadata.appointmentId` (see
// lib/stripe.js's createPaymentIntent/createPaymentLink comments for when that's set) — a booking
// deposit's PaymentIntent has no appointmentId yet at creation time (the appointment doesn't exist
// until src/functions/book.js's own transaction creates it), so this handler can't and doesn't try to
// act on those; book.js's synchronous verification is the real path for deposits, this is purely a
// safety net for the balance-payment and Payment-Link flows where no synchronous caller exists.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { constructWebhookEvent } = require('../../../lib/stripe');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function recordCardPayment(db, { appointmentId, paymentIntentId, amountCents, context }) {
  const { rows: apptRows } = await db.query('SELECT id, customer_id FROM appointments WHERE id = $1', [appointmentId]);
  if (apptRows.length === 0) {
    context.warn(`Stripe webhook: PaymentIntent ${paymentIntentId} references unknown appointment ${appointmentId}, skipping`);
    return;
  }
  const customerId = apptRows[0].customer_id;
  try {
    await db.query(
      `INSERT INTO billing_entries (appointment_id, customer_id, amount_cents, method, source, external_ref, recorded_by)
       VALUES ($1, $2, $3, 'card', 'stripe', $4, 'stripe_webhook')`,
      [appointmentId, customerId, amountCents, paymentIntentId]
    );
  } catch (err) {
    if (err && err.code === '23505') {
      // Unique violation on external_ref — already recorded (redelivered event, or the
      // synchronous booking/balance-payment path already inserted this exact PaymentIntent). Not
      // an error, just the idempotency guard doing its job.
      return;
    }
    throw err;
  }
}

async function paymentsWebhookHandler(request, context) {
  const signature = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    context.warn('Stripe webhook signature verification failed:', err.message);
    return { status: 400, jsonBody: { error: 'Invalid signature' } };
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const appointmentId = intent.metadata && intent.metadata.appointmentId;
      if (appointmentId) {
        const db = getPool();
        await recordCardPayment(db, {
          appointmentId,
          paymentIntentId: intent.id,
          amountCents: intent.amount,
          context,
        });
      }
      // No appointmentId (a booking-deposit PaymentIntent whose /api/book call never landed) is
      // deliberately not auto-resolved here — see this file's header comment on why acting on it
      // (e.g. auto-creating an appointment) isn't safe without re-checking slot availability.
    }
    return { status: 200, jsonBody: { received: true } };
  } catch (err) {
    context.error('Stripe webhook processing failed:', err);
    // 500 so Stripe retries this delivery — a transient DB error shouldn't silently drop the event.
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('paymentsWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'payments/webhook',
  handler: paymentsWebhookHandler,
});

module.exports = { paymentsWebhookHandler, recordCardPayment };
