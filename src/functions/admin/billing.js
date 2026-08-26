// GET  /api/staffconsole/appointments/{id}/billing — list the manual-payment ledger entries recorded
//                                              against one appointment (oldest first), for
//                                              admin.html's per-appointment "Payment" panel.
// POST /api/staffconsole/appointments/{id}/billing — record a new entry: {amountCents, method, note?}.
//                                              `amountCents` is an integer (see db/schema.sql's
//                                              billing_entries.amount_cents comment for why cents,
//                                              not dollars/floats). `customer_id` is copied from the
//                                              appointment at insert time (nullable — most bookings
//                                              are still guest bookings with no linked customer,
//                                              which is fine, the ledger still lives against the
//                                              appointment either way). `source` is hardcoded
//                                              'manual' and `recorded_by` 'admin' here — see
//                                              db/schema.sql's forward-compatibility note for why
//                                              those columns exist at all (a future Stripe/Shopify
//                                              integration would write different values into the
//                                              same table, no migration needed).
// POST /api/staffconsole/appointments/{id}/billing/pay-link — generate a Stripe-hosted Payment Link
//                                              for a staff-specified amount: {amountCents, note?} ->
//                                              {url}. This is the v1 admin-initiated-charge flow (see
//                                              lib/stripe.js's createPaymentLink comment) — staff send
//                                              the returned URL to the customer off-app (text/email)
//                                              to pay on Stripe's own hosted page. Deliberately does
//                                              NOT insert a billing_entries row itself: nothing here
//                                              knows whether/when the customer actually pays, only
//                                              Stripe's webhook (src/functions/payments/webhook.js)
//                                              does, once payment_intent.succeeded arrives with this
//                                              link's metadata.appointmentId — that webhook is the
//                                              single recorder for this flow, same idempotency
//                                              guarantee (unique index on billing_entries.external_ref)
//                                              as every other card-payment path in this project.
// All three behind requireAdmin(), reused unchanged from lib/adminAuth.js.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');
const { createPaymentLink, isConfigured: stripeIsConfigured } = require('../../../lib/stripe');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const ALLOWED_METHODS = ['cash_app', 'zelle', 'cash', 'other'];

async function adminBillingListHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const appointmentId = request.params.id;
  if (!/^\d+$/.test(String(appointmentId))) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  try {
    const { rows } = await db.query(
      `SELECT id, appointment_id, customer_id, amount_cents, method, note, source, recorded_by, created_at
       FROM billing_entries WHERE appointment_id = $1 ORDER BY created_at ASC`,
      [appointmentId]
    );
    return { status: 200, jsonBody: { entries: rows } };
  } catch (err) {
    context.error('GET /api/staffconsole/appointments/:id/billing failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

function validateBillingBody(body) {
  const errors = [];
  const amountCents = body && Number(body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    errors.push('amountCents is required and must be a positive integer (whole cents)');
  }
  const method = body && body.method;
  if (!ALLOWED_METHODS.includes(method)) {
    errors.push(`method must be one of: ${ALLOWED_METHODS.join(', ')}`);
  }
  return { errors, amountCents, method };
}

async function adminBillingCreateHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const appointmentId = request.params.id;
  if (!/^\d+$/.test(String(appointmentId))) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const { errors, amountCents, method } = validateBillingBody(body);
  if (errors.length) return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };
  const note = body && body.note ? String(body.note).trim() : null;

  try {
    const { rows: apptRows } = await db.query(
      'SELECT id, customer_id FROM appointments WHERE id = $1',
      [appointmentId]
    );
    if (apptRows.length === 0) {
      return { status: 404, jsonBody: { error: 'Appointment not found' } };
    }
    const customerId = apptRows[0].customer_id;

    const { rows } = await db.query(
      `INSERT INTO billing_entries (appointment_id, customer_id, amount_cents, method, note, source, recorded_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'admin')
       RETURNING id, appointment_id, customer_id, amount_cents, method, note, source, recorded_by, created_at`,
      [appointmentId, customerId, amountCents, method, note]
    );
    return { status: 201, jsonBody: { entry: rows[0] } };
  } catch (err) {
    context.error('POST /api/staffconsole/appointments/:id/billing failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

function validatePayLinkBody(body) {
  const errors = [];
  const amountCents = body && Number(body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    errors.push('amountCents is required and must be a positive integer (whole cents)');
  }
  return { errors, amountCents };
}

async function adminBillingPayLinkHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const appointmentId = request.params.id;
  if (!/^\d+$/.test(String(appointmentId))) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const { errors, amountCents } = validatePayLinkBody(body);
  if (errors.length) return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };

  if (!stripeIsConfigured()) {
    return { status: 503, jsonBody: { error: 'Stripe is not configured', code: 'not_configured' } };
  }

  try {
    const { rows: apptRows } = await db.query(
      'SELECT id, customer_id, customer_name FROM appointments WHERE id = $1',
      [appointmentId]
    );
    if (apptRows.length === 0) {
      return { status: 404, jsonBody: { error: 'Appointment not found' } };
    }
    const { customer_id: customerId, customer_name: customerName } = apptRows[0];

    const link = await createPaymentLink({
      amountCents,
      currency: 'usd',
      description: 'AFRIKANADOLLZ balance — ' + (customerName || ('appointment #' + appointmentId)),
      metadata: {
        purpose: 'admin_link',
        appointmentId: String(appointmentId),
        customerId: String(customerId || ''),
      },
    });
    return { status: 200, jsonBody: { url: link.url } };
  } catch (err) {
    context.error('POST /api/staffconsole/appointments/:id/billing/pay-link failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminBillingList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/appointments/{id}/billing',
  handler: adminBillingListHandler,
});

app.http('adminBillingCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/appointments/{id}/billing',
  handler: adminBillingCreateHandler,
});

app.http('adminBillingPayLink', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/appointments/{id}/billing/pay-link',
  handler: adminBillingPayLinkHandler,
});

module.exports = {
  adminBillingListHandler,
  adminBillingCreateHandler,
  adminBillingPayLinkHandler,
  ALLOWED_METHODS,
  validateBillingBody,
  validatePayLinkBody,
};
