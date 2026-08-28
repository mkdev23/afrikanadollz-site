// GET   /api/staffconsole/custom-orders?status=      — list custom wig orders (db/schema.sql's
//                                                 custom_wig_orders — see src/functions/
//                                                 customWigOrder.js for the public intake side of
//                                                 this feature), newest-first. `status` is optional;
//                                                 omitted returns every order regardless of status,
//                                                 present must be one of ALLOWED_STATUSES below.
// GET   /api/staffconsole/custom-orders/{id}          — one order's full detail (contact info,
//                                                 measurements, cap size, lace preference, style
//                                                 notes, reference photo, status).
// PATCH /api/staffconsole/custom-orders/{id}          — update an order. Body is a partial patch, same
//                                                 semantics as src/functions/admin/clients.js's PUT:
//                                                 any of status/capSize/styleNotes/the six measurement
//                                                 fields may be omitted (left unchanged); at least one
//                                                 must be present. Bumps updated_at. `status`, when
//                                                 present, must be one of ALLOWED_STATUSES; the six
//                                                 measurement fields are bounds-checked identically to
//                                                 src/functions/customWigOrder.js's validateBody().
//
// All three behind requireAdmin(), reused unchanged from lib/adminAuth.js — same pattern as every
// other src/functions/admin/*.js file.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const ALLOWED_STATUSES = ['new', 'in_progress', 'ready', 'completed', 'cancelled'];
const CAP_SIZES = ['small', 'medium', 'large'];

// Same bound/reasoning as src/functions/customWigOrder.js's MIN_MEASUREMENT_IN/MAX_MEASUREMENT_IN and
// the matching CHECK constraints in db/schema.sql — duplicated rather than imported for the same
// "small, pure, self-contained module" reasoning documented on that file's referencePhotoUrlPrefix().
const MIN_MEASUREMENT_IN = 0;
const MAX_MEASUREMENT_IN = 40;

// [jsonBodyKey, dbColumn] — identical field set to src/functions/customWigOrder.js's
// MEASUREMENT_FIELDS (kept as a separate copy for the same self-contained-module reasoning above).
const MEASUREMENT_FIELDS = [
  ['circumferenceIn', 'circumference_in'],
  ['frontToNapeIn', 'front_to_nape_in'],
  ['earToEarForeheadIn', 'ear_to_ear_forehead_in'],
  ['earToEarTopIn', 'ear_to_ear_top_in'],
  ['templeToTempleIn', 'temple_to_temple_in'],
  ['napeOfNeckIn', 'nape_of_neck_in'],
];

const ORDER_COLUMNS = `id, customer_name, customer_phone, customer_email, customer_id,
         circumference_in, front_to_nape_in, ear_to_ear_forehead_in, ear_to_ear_top_in,
         temple_to_temple_in, nape_of_neck_in, cap_size, lace_style, style_notes,
         reference_photo_url, status, created_at, updated_at`;

function isIntegerId(v) {
  return /^\d+$/.test(String(v));
}

// ---------------- GET /api/staffconsole/custom-orders ----------------

async function adminCustomOrdersListHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const status = request.query.get('status');
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return { status: 400, jsonBody: { error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` } };
  }

  try {
    const { rows } = status
      ? await db.query(
          `SELECT ${ORDER_COLUMNS} FROM custom_wig_orders WHERE status = $1 ORDER BY created_at DESC`,
          [status]
        )
      : await db.query(`SELECT ${ORDER_COLUMNS} FROM custom_wig_orders ORDER BY created_at DESC`);
    return { status: 200, jsonBody: { orders: rows } };
  } catch (err) {
    context.error('GET /api/staffconsole/custom-orders failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

// ---------------- GET /api/staffconsole/custom-orders/{id} ----------------

async function adminCustomOrderDetailHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const id = request.params.id;
  if (!isIntegerId(id)) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  try {
    const { rows } = await db.query(`SELECT ${ORDER_COLUMNS} FROM custom_wig_orders WHERE id = $1`, [id]);
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: 'Custom wig order not found' } };
    }
    return { status: 200, jsonBody: { order: rows[0] } };
  } catch (err) {
    context.error('GET /api/staffconsole/custom-orders/:id failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

// ---------------- PATCH /api/staffconsole/custom-orders/{id} ----------------

// Builds the SET clause for a partial patch. Returns {sets, values, errors} — same shape/spirit as
// src/functions/admin/clients.js's buildProfileUpdate, extended with validation (status/capSize/
// measurement bounds) since, unlike that free-text-only profile patch, several of these fields have a
// real constrained shape worth rejecting early with a friendly message.
function buildOrderUpdate(body) {
  const sets = [];
  const values = [];
  const errors = [];
  if (!body || typeof body !== 'object') return { sets, values, errors };

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    if (!ALLOWED_STATUSES.includes(body.status)) {
      errors.push(`status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
    } else {
      values.push(body.status);
      sets.push(`status = $${values.length}`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'capSize')) {
    const raw = body.capSize;
    if (raw === null || raw === '') {
      values.push(null);
      sets.push(`cap_size = $${values.length}`);
    } else if (!CAP_SIZES.includes(raw)) {
      errors.push(`capSize must be one of: ${CAP_SIZES.join(', ')}`);
    } else {
      values.push(raw);
      sets.push(`cap_size = $${values.length}`);
    }
  }

  for (const [jsonKey, column] of MEASUREMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, jsonKey)) continue;
    const raw = body[jsonKey];
    if (raw === null || raw === '') {
      values.push(null);
      sets.push(`${column} = $${values.length}`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= MIN_MEASUREMENT_IN || n > MAX_MEASUREMENT_IN) {
      errors.push(`${jsonKey} must be a number greater than ${MIN_MEASUREMENT_IN} and at most ${MAX_MEASUREMENT_IN} (inches)`);
      continue;
    }
    values.push(n);
    sets.push(`${column} = $${values.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'styleNotes')) {
    const raw = body.styleNotes;
    const value = raw === null || raw === undefined ? null : String(raw).trim() || null;
    values.push(value);
    sets.push(`style_notes = $${values.length}`);
  }

  return { sets, values, errors };
}

async function adminCustomOrderUpdateHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const id = request.params.id;
  if (!isIntegerId(id)) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const { sets, values, errors } = buildOrderUpdate(body);
  if (errors.length) {
    return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };
  }
  if (sets.length === 0) {
    return {
      status: 400,
      jsonBody: { error: 'At least one of status, capSize, styleNotes, or a measurement field is required' },
    };
  }

  try {
    values.push(id);
    const { rows } = await db.query(
      `UPDATE custom_wig_orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}
       RETURNING ${ORDER_COLUMNS}`,
      values
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: 'Custom wig order not found' } };
    }
    return { status: 200, jsonBody: { order: rows[0] } };
  } catch (err) {
    context.error('PATCH /api/staffconsole/custom-orders/:id failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminCustomOrdersList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/custom-orders',
  handler: adminCustomOrdersListHandler,
});

app.http('adminCustomOrderDetail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/custom-orders/{id}',
  handler: adminCustomOrderDetailHandler,
});

app.http('adminCustomOrderUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'staffconsole/custom-orders/{id}',
  handler: adminCustomOrderUpdateHandler,
});

module.exports = {
  adminCustomOrdersListHandler,
  adminCustomOrderDetailHandler,
  adminCustomOrderUpdateHandler,
  buildOrderUpdate,
  ALLOWED_STATUSES,
  CAP_SIZES,
  MEASUREMENT_FIELDS,
};
