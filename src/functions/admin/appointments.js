// GET  /api/staffconsole/appointments?from=&to=          — bookings in a local-calendar date range, enough
//                                                     detail to power admin.html's month calendar.
// POST /api/staffconsole/appointments/{id}/status         — update status (confirmed|cancelled|completed|
//                                                     no_show). Not in the original plan's endpoint
//                                                     list, but a salon owner needs to mark no-shows
//                                                     and completions for the page to be useful.
// Both behind requireAdmin(). Same DB-query conventions as src/functions/availability.js (a `pool`
// singleton, the +/-1 day widening on the range so appointments straddling local-midnight in UTC are
// still caught).
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

const ALLOWED_STATUSES = ['confirmed', 'cancelled', 'completed', 'no_show'];

async function adminAppointmentsListHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const from = request.query.get('from');
  const to = request.query.get('to');
  if (!isValidDate(from) || !isValidDate(to)) {
    return { status: 400, jsonBody: { error: 'from and to are required, as YYYY-MM-DD' } };
  }
  if (from > to) {
    return { status: 400, jsonBody: { error: 'from must be <= to' } };
  }

  try {
    const { rows } = await db.query(
      `SELECT a.id, a.service_id, s.name AS service_name, s.category AS service_category,
              a.customer_name, a.customer_phone, a.customer_email, a.notes,
              a.start_at, a.end_at, a.status, a.sms_opt_in, a.sms_phone,
              a.reminder_sent, a.created_at, a.inspiration_photo_url
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.start_at < ($2::date + interval '1 day') AND a.end_at > ($1::date - interval '1 day')
       ORDER BY a.start_at ASC`,
      [from, to]
    );
    return { status: 200, jsonBody: { appointments: rows } };
  } catch (err) {
    context.error('GET /api/staffconsole/appointments failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function adminAppointmentStatusHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const id = request.params.id;
  if (!/^\d+$/.test(String(id))) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const status = body && body.status;
  if (!ALLOWED_STATUSES.includes(status)) {
    return { status: 400, jsonBody: { error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` } };
  }

  try {
    const { rows } = await db.query(
      `UPDATE appointments SET status = $1 WHERE id = $2
       RETURNING id, service_id, customer_name, customer_phone, customer_email, notes,
                 start_at, end_at, status, sms_opt_in, sms_phone, reminder_sent, created_at`,
      [status, id]
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: 'Appointment not found' } };
    }
    return { status: 200, jsonBody: { appointment: rows[0] } };
  } catch (err) {
    context.error('POST /api/staffconsole/appointments/:id/status failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminAppointmentsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/appointments',
  handler: adminAppointmentsListHandler,
});

app.http('adminAppointmentStatus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/appointments/{id}/status',
  handler: adminAppointmentStatusHandler,
});

module.exports = { adminAppointmentsListHandler, adminAppointmentStatusHandler, ALLOWED_STATUSES };
