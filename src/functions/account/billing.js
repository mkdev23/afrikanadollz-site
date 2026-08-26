// GET /api/account/billing — the logged-in customer's own manual-payment ledger entries (see
// db/schema.sql's billing_entries table), newest first, plus a running totalCents. Scoped
// server-side via requireCustomer()'s verified customer_id, same as accountAppointments.js — a
// customer can only ever see entries recorded against their own account, never anyone else's.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireCustomer } = require('../../../lib/customerAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function accountBillingHandler(request, context) {
  const auth = requireCustomer(request);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT b.id, b.appointment_id, b.amount_cents, b.method, b.note, b.source, b.created_at,
              s.name AS service_name, a.start_at AS appointment_start_at
       FROM billing_entries b
       JOIN appointments a ON a.id = b.appointment_id
       JOIN services s ON s.id = a.service_id
       WHERE b.customer_id = $1
       ORDER BY b.created_at DESC`,
      [auth.customerId]
    );
    const totalCents = rows.reduce((sum, r) => sum + Number(r.amount_cents), 0);
    return { status: 200, jsonBody: { entries: rows, totalCents } };
  } catch (err) {
    context.error('GET /api/account/billing failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('accountBilling', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'account/billing',
  handler: accountBillingHandler,
});

module.exports = { accountBillingHandler };
