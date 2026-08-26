// GET  /api/staffconsole/clients?search=        — list/search customers by name/email/phone (ILIKE,
//                                            substring), newest-created first, for admin.html's
//                                            Clients tab directory. `search` is optional; omitted or
//                                            empty returns every customer.
// GET  /api/staffconsole/clients/{id}            — one customer's full profile: contact info, the
//                                            current-state fields (hair_type/hair_texture/allergies/
//                                            preferences), their appointment history (newest first),
//                                            and their notes timeline (newest first).
// PUT  /api/staffconsole/clients/{id}            — update the current-state profile fields. Body is a
//                                            partial patch: any of hair_type/hair_texture/allergies/
//                                            preferences may be omitted (left unchanged) or set to a
//                                            string/null; anything else in the body is ignored.
// POST /api/staffconsole/clients/{id}/notes      — append a note to that customer's timeline. Body:
//                                            {note, appointmentId?}. `note` is required, non-empty.
//                                            `appointmentId` is optional (a note doesn't always tie to
//                                            a specific visit) and, if given, must reference an
//                                            appointment that actually belongs to this customer.
//
// All four behind requireAdmin(), reused unchanged from lib/adminAuth.js — this data is staff-only
// (see db/schema.sql's client_notes comment for why: some notes record sensitive things a stylist
// wants recorded privately) and is never reachable from /api/account/* or any customer-facing code.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const PROFILE_FIELDS = ['hair_type', 'hair_texture', 'allergies', 'preferences'];

function isIntegerId(v) {
  return /^\d+$/.test(String(v));
}

// ---------------- GET /api/staffconsole/clients ----------------

async function adminClientsListHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const search = (request.query.get('search') || '').trim();

  try {
    let rows;
    if (search) {
      // Phone numbers are stored however they were typed at write time (booking or sign-in — see
      // lib/phone.js's header comment) and, for any row written before that helper existed, may never
      // get retroactively reformatted (no backfill migration is run here — see auth.js's
      // findExistingCustomer comment on the same gap). A plain `phone ILIKE $1` against the raw column
      // would therefore miss a match whenever staff types the search in a different shape than
      // what's stored — e.g. searching "(267) 481-4058" against a row stored as "+12674814058".
      // Comparing digit-only versions of both sides at query time (regexp_replace, not a stored
      // transform) fixes this for every row already in the table with no migration needed.
      //
      // Also matches against appointments.customer_phone, not just customers.phone: a customer's own
      // `phone` column is only ever populated by an SMS/OTP sign-in (see auth.js) — someone who signed
      // up by email but gave their phone number at booking time (guest or logged-in) has customers.phone
      // permanently NULL despite a real, findable phone number sitting on their appointment(s). In
      // practice this made phone search nearly useless (confirmed live: every customer row in this
      // database has phone = NULL today, since nobody has signed in via SMS yet) — searching by the
      // phone number staff actually has on hand (from a booking) must work regardless of which column
      // it happens to live in. The EXISTS subquery is scoped to appointments already linked to this
      // customer (appointment_id via customer_id) — it deliberately does NOT search *unlinked* guest
      // appointments' phone numbers here, since matching those would surface a phone number that was
      // never actually proven to belong to this customer account (same "don't cross-match unverified
      // identifiers" principle as auth.js's linkOrphanGuestAppointments).
      //
      // Only applied when the search term itself contains at least a few digits — DIGIT_SEARCH_MIN
      // below — so a pure-letters name search like "Jasmine" (zero digits to strip) never triggers a
      // digits-only comparison; name/email matching stays exactly the plain ILIKE it always was.
      const searchDigits = search.replace(/\D/g, '');
      const DIGIT_SEARCH_MIN = 3;
      const includesPhoneMatch = searchDigits.length >= DIGIT_SEARCH_MIN;
      const phoneClause = includesPhoneMatch
        ? ` OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ILIKE '%' || $2 || '%'
            OR EXISTS (
              SELECT 1 FROM appointments a
              WHERE a.customer_id = customers.id
                AND regexp_replace(COALESCE(a.customer_phone, ''), '[^0-9]', '', 'g') ILIKE '%' || $2 || '%'
            )`
        : '';
      const params = includesPhoneMatch ? [`%${search}%`, searchDigits] : [`%${search}%`];
      ({ rows } = await db.query(
        `SELECT id, name, email, phone, hair_type, hair_texture, allergies, preferences, created_at
         FROM customers
         WHERE name ILIKE $1 OR email ILIKE $1${phoneClause}
         ORDER BY created_at DESC`,
        params
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT id, name, email, phone, hair_type, hair_texture, allergies, preferences, created_at
         FROM customers
         ORDER BY created_at DESC`
      ));
    }
    return { status: 200, jsonBody: { customers: rows } };
  } catch (err) {
    context.error('GET /api/staffconsole/clients failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

// ---------------- GET /api/staffconsole/clients/{id} ----------------

async function adminClientDetailHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const id = request.params.id;
  if (!isIntegerId(id)) {
    return { status: 400, jsonBody: { error: 'id must be an integer' } };
  }

  try {
    const { rows: customerRows } = await db.query(
      `SELECT id, name, email, phone, hair_type, hair_texture, allergies, preferences, created_at
       FROM customers WHERE id = $1`,
      [id]
    );
    if (customerRows.length === 0) {
      return { status: 404, jsonBody: { error: 'Customer not found' } };
    }

    const [{ rows: appointments }, { rows: notes }] = await Promise.all([
      db.query(
        `SELECT a.id, a.service_id, s.name AS service_name, s.category AS service_category,
                a.start_at, a.end_at, a.status, a.notes, a.created_at
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         WHERE a.customer_id = $1
         ORDER BY a.start_at DESC`,
        [id]
      ),
      db.query(
        `SELECT id, customer_id, appointment_id, note, created_by, created_at
         FROM client_notes WHERE customer_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
    ]);

    return {
      status: 200,
      jsonBody: { customer: customerRows[0], appointments, notes },
    };
  } catch (err) {
    context.error('GET /api/staffconsole/clients/:id failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

// ---------------- PUT /api/staffconsole/clients/{id} ----------------

function buildProfileUpdate(body) {
  // Partial patch: only fields actually present in the body are touched. A present field may be set
  // to a string (trimmed) or explicitly cleared with null/''; an absent field is left unchanged.
  const sets = [];
  const values = [];
  for (const field of PROFILE_FIELDS) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    const value = raw === null || raw === undefined ? null : String(raw).trim() || null;
    values.push(value);
    sets.push(`${field} = $${values.length}`);
  }
  return { sets, values };
}

async function adminClientUpdateHandler(request, context) {
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

  const { sets, values } = buildProfileUpdate(body);
  if (sets.length === 0) {
    return { status: 400, jsonBody: { error: 'At least one of hair_type, hair_texture, allergies, preferences is required' } };
  }

  try {
    values.push(id);
    const { rows } = await db.query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, name, email, phone, hair_type, hair_texture, allergies, preferences, created_at`,
      values
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: 'Customer not found' } };
    }
    return { status: 200, jsonBody: { customer: rows[0] } };
  } catch (err) {
    context.error('PUT /api/staffconsole/clients/:id failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

// ---------------- POST /api/staffconsole/clients/{id}/notes ----------------

async function adminClientNoteCreateHandler(request, context) {
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

  const note = body && typeof body.note === 'string' ? body.note.trim() : '';
  const errors = [];
  if (!note) errors.push('note is required and cannot be empty');

  let appointmentId = null;
  if (body && body.appointmentId !== undefined && body.appointmentId !== null && body.appointmentId !== '') {
    if (!isIntegerId(body.appointmentId)) {
      errors.push('appointmentId must be an integer when provided');
    } else {
      appointmentId = String(body.appointmentId);
    }
  }
  if (errors.length) return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };

  try {
    const { rows: customerRows } = await db.query('SELECT id FROM customers WHERE id = $1', [id]);
    if (customerRows.length === 0) {
      return { status: 404, jsonBody: { error: 'Customer not found' } };
    }

    if (appointmentId) {
      const { rows: apptRows } = await db.query(
        'SELECT id FROM appointments WHERE id = $1 AND customer_id = $2',
        [appointmentId, id]
      );
      if (apptRows.length === 0) {
        return { status: 400, jsonBody: { error: 'appointmentId does not reference an appointment belonging to this customer' } };
      }
    }

    const { rows } = await db.query(
      `INSERT INTO client_notes (customer_id, appointment_id, note, created_by)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, customer_id, appointment_id, note, created_by, created_at`,
      [id, appointmentId, note]
    );
    return { status: 201, jsonBody: { note: rows[0] } };
  } catch (err) {
    context.error('POST /api/staffconsole/clients/:id/notes failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminClientsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/clients',
  handler: adminClientsListHandler,
});

app.http('adminClientDetail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/clients/{id}',
  handler: adminClientDetailHandler,
});

app.http('adminClientUpdate', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'staffconsole/clients/{id}',
  handler: adminClientUpdateHandler,
});

app.http('adminClientNoteCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/clients/{id}/notes',
  handler: adminClientNoteCreateHandler,
});

module.exports = {
  adminClientsListHandler,
  adminClientDetailHandler,
  adminClientUpdateHandler,
  adminClientNoteCreateHandler,
  PROFILE_FIELDS,
  buildProfileUpdate,
};
