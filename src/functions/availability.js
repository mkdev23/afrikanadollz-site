// GET /api/availability?serviceId=&from=&to= — thin HTTP wrapper around lib/availability.js's
// computeSlots. All slot-math lives there so it can be unit-tested without a DB; this file just
// fetches the rows and wires them through.
//
// Ported from the original Vercel-style api/availability.js to the Azure Functions Node.js v4
// programming model: same queries, same response shape, same 200/400/404/500 status codes. Query
// string params now come from `request.query.get(...)` (a URLSearchParams-like object) instead of
// `req.query`. See src/functions/services.js's header comment for the one behavioral difference
// (wrong-method requests now 404 via Azure's router instead of an explicit 405 body).
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { computeSlots } = require('../../lib/availability');

const TIMEZONE = 'America/New_York'; // salon is in Philadelphia, PA

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

async function availabilityHandler(request, context) {
  const serviceId = request.query.get('serviceId');
  const from = request.query.get('from');
  const to = request.query.get('to');

  if (!serviceId || !/^\d+$/.test(String(serviceId))) {
    return { status: 400, jsonBody: { error: 'serviceId is required and must be an integer' } };
  }
  if (!isValidDate(from) || !isValidDate(to)) {
    return { status: 400, jsonBody: { error: 'from and to are required, as YYYY-MM-DD' } };
  }
  if (from > to) {
    return { status: 400, jsonBody: { error: 'from must be <= to' } };
  }

  try {
    const db = getPool();

    const { rows: serviceRows } = await db.query(
      'SELECT id, duration_min, buffer_min FROM services WHERE id = $1 AND active = true',
      [serviceId]
    );
    if (serviceRows.length === 0) {
      return { status: 404, jsonBody: { error: 'Service not found' } };
    }
    const service = serviceRows[0];

    // Widen the DB queries by one day on each side of [from, to] so appointments/blocks that
    // straddle midnight in local time (but not in UTC) are still picked up by computeSlots' overlap check.
    const { rows: blocks } = await db.query(
      `SELECT start_at, end_at FROM blocked_slots
       WHERE start_at < ($2::date + interval '1 day') AND end_at > ($1::date - interval '1 day')`,
      [from, to]
    );

    const { rows: appointments } = await db.query(
      `SELECT start_at, end_at FROM appointments
       WHERE status = 'confirmed'
         AND start_at < ($2::date + interval '1 day') AND end_at > ($1::date - interval '1 day')`,
      [from, to]
    );

    const { rows: rules } = await db.query(
      'SELECT weekday, start_time, end_time FROM availability_rules'
    );

    const days = computeSlots(
      rules,
      blocks,
      appointments,
      service.duration_min,
      service.buffer_min,
      { from, to },
      TIMEZONE
    );

    return { status: 200, jsonBody: { serviceId: service.id, timezone: TIMEZONE, days } };
  } catch (err) {
    context.error('GET /api/availability failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('availability', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'availability',
  handler: availabilityHandler,
});

module.exports = { availabilityHandler };
