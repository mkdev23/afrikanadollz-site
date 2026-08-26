// GET /api/account/appointments — the logged-in customer's own appointment history (upcoming +
// past), newest first. Scoped server-side via requireCustomer()'s verified customer_id — never a
// client-supplied id — so a customer can only ever see their own bookings, matching the pattern of
// every other /api/account/* handler in this folder. Same JOIN-services shape as
// src/functions/admin/appointments.js's list query, minus the admin-only fields (phone/email/notes
// aren't re-shown to the customer here since they typed them; sms_opt_in/reminder_sent are internal
// operational detail, not customer-facing).
//
// `price_cents` was added to the SELECT for the "Pay balance" feature (account.html's billing
// ledger): the frontend needs each appointment's service price, alongside GET /api/account/billing's
// already-returned per-appointment amount_cents, to compute a remaining balance client-side without
// a third round trip. Purely additive to the response shape — every existing consumer of this
// endpoint already ignores fields it doesn't recognize.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireCustomer } = require('../../../lib/customerAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function accountAppointmentsHandler(request, context) {
  const auth = requireCustomer(request);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT a.id, a.service_id, s.name AS service_name, s.category AS service_category,
              s.price_cents, a.start_at, a.end_at, a.status, a.notes, a.created_at
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.customer_id = $1
       ORDER BY a.start_at DESC`,
      [auth.customerId]
    );
    return { status: 200, jsonBody: { appointments: rows } };
  } catch (err) {
    context.error('GET /api/account/appointments failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('accountAppointments', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'account/appointments',
  handler: accountAppointmentsHandler,
});

module.exports = { accountAppointmentsHandler };
