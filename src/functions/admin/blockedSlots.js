// GET    /api/staffconsole/blocked-slots            — list one-off blocks (powers admin.html's blocked-
//                                                dates manager and the calendar's "blocked" markers).
// POST   /api/staffconsole/blocked-slots             — add a one-off block. Accepts LOCAL wall-clock fields
//                                                (date/allDay/startTime/endTime), not raw UTC instants
//                                                — the admin thinks in Philadelphia time, same as the
//                                                availability_rules table does. Converting that to a
//                                                UTC instant needs the exact same DST-aware math
//                                                /api/availability.js and /api/book.js already use, so
//                                                this reuses lib/availability.js's zonedWallTimeToUtc
//                                                rather than re-deriving date/DST logic here.
// DELETE /api/staffconsole/blocked-slots/{id}        — remove a block.
// All behind requireAdmin().
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');
const { zonedWallTimeToUtc } = require('../../../lib/availability');

const TIMEZONE = 'America/New_York'; // salon is in Philadelphia, PA — same as the rest of the booking system

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
function nextCalendarDay(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

async function adminBlockedSlotsListHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const { rows } = await db.query(
      'SELECT id, start_at, end_at, reason FROM blocked_slots ORDER BY start_at ASC'
    );
    return { status: 200, jsonBody: { blockedSlots: rows } };
  } catch (err) {
    context.error('GET /api/staffconsole/blocked-slots failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { errors: ['Request body must be JSON'] };

  const date = body.date;
  if (!isValidDate(date)) errors.push('date is required, as YYYY-MM-DD');

  const allDay = Boolean(body.allDay);
  let startTime = null;
  let endTime = null;
  if (!allDay) {
    startTime = body.startTime;
    endTime = body.endTime;
    if (!isValidTime(startTime)) errors.push('startTime is required (HH:MM), unless allDay is true');
    if (!isValidTime(endTime)) errors.push('endTime is required (HH:MM), unless allDay is true');
    if (isValidTime(startTime) && isValidTime(endTime) && startTime >= endTime) {
      errors.push('startTime must be before endTime');
    }
  }

  return { errors, date, allDay, startTime, endTime };
}

async function adminBlockedSlotsCreateHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const { errors, date, allDay, startTime, endTime } = validateBody(body);
  if (errors.length) return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };

  const { y, m, d } = parseYmd(date);
  let startAt;
  let endAt;
  if (allDay) {
    startAt = zonedWallTimeToUtc(y, m, d, 0, 0, TIMEZONE);
    const next = nextCalendarDay(y, m, d);
    endAt = zonedWallTimeToUtc(next.y, next.m, next.d, 0, 0, TIMEZONE);
  } else {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    startAt = zonedWallTimeToUtc(y, m, d, sh, sm, TIMEZONE);
    endAt = zonedWallTimeToUtc(y, m, d, eh, em, TIMEZONE);
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO blocked_slots (start_at, end_at, reason) VALUES ($1, $2, $3)
       RETURNING id, start_at, end_at, reason`,
      [startAt.toISOString(), endAt.toISOString(), body.reason ? String(body.reason).trim() : null]
    );
    return { status: 201, jsonBody: { blockedSlot: rows[0] } };
  } catch (err) {
    context.error('POST /api/staffconsole/blocked-slots failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function adminBlockedSlotsDeleteHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const id = request.params.id;
  if (!/^\d+$/.test(String(id))) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  try {
    const { rowCount } = await db.query('DELETE FROM blocked_slots WHERE id = $1', [id]);
    if (rowCount === 0) return { status: 404, jsonBody: { error: 'Blocked slot not found' } };
    return { status: 204 };
  } catch (err) {
    context.error('DELETE /api/staffconsole/blocked-slots/:id failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminBlockedSlotsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/blocked-slots',
  handler: adminBlockedSlotsListHandler,
});

app.http('adminBlockedSlotsCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/blocked-slots',
  handler: adminBlockedSlotsCreateHandler,
});

app.http('adminBlockedSlotsDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'staffconsole/blocked-slots/{id}',
  handler: adminBlockedSlotsDeleteHandler,
});

module.exports = {
  adminBlockedSlotsListHandler,
  adminBlockedSlotsCreateHandler,
  adminBlockedSlotsDeleteHandler,
  validateBody,
};
