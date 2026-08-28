// POST /api/custom-wig-order — creates a custom_wig_orders row (a product-order intake, NOT a
// time-slot appointment: that's the unrelated `appointments` table / src/functions/book.js /
// book.html), then fires both confirmation emails (customer + business) via the same Azure
// Communication Services Email pattern src/functions/book.js/lib/email.js use for a booking. Email
// sending is log-not-fail, same as book.js: the DB row is already committed and is the source of
// truth, so an email hiccup can never turn a successful order into a 500.
//
// Guest-friendly, anonymous auth level — same as POST /api/book. Placing a custom order never
// requires an account; if a valid customer session cookie is present, optionalCustomerId() links the
// order to that account exactly like book.js does for a booking, otherwise it's a guest order
// (customer_id stays NULL). See db/schema.sql's custom_wig_orders comment for the flagged follow-up:
// unlike a guest *booking*, a guest custom order is NOT retroactively linked if that guest later
// creates an account (src/functions/auth/auth.js's linkOrphanGuestAppointments only touches
// `appointments`) — left out of this feature's scope deliberately, see the task report.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { sendCustomWigOrderConfirmations } = require('../../lib/email');
const { optionalCustomerId } = require('../../lib/customerAuth');
const { normalizePhone } = require('../../lib/phone');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LACE_STYLES = ['precut', 'uncut', 'unsure'];
const CAP_SIZES = ['small', 'medium', 'large'];

// Same bound, same reasoning, as the CHECK constraints on custom_wig_orders' six measurement columns
// in db/schema.sql — re-checked here so a bad value comes back as a friendly 400 with the offending
// field name instead of an opaque Postgres constraint-violation 500. See that file's comment for the
// full reasoning; short version: no real head measurement gets anywhere close to 40in (an adult head
// circumference is roughly 20-24in), so this generously covers every legitimate outlier while still
// catching plain data-entry mistakes (a stray negative sign, an extra typed digit, centimeters typed
// where inches were meant).
const MIN_MEASUREMENT_IN = 0;
const MAX_MEASUREMENT_IN = 40;

// [jsonBodyKey, dbColumn] — the single source of truth for which six measurement fields exist, used
// by both validateBody() and the INSERT below so the two can never drift out of sync with each other.
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

// Mirrors src/functions/book.js's inspirationPhotoUrlPrefix() exactly — same blob container/env vars,
// same "never trust a client-supplied URL at face value, only accept one that actually points into
// the container this app controls" reasoning (see that function's header comment for the full
// rationale). Duplicated here rather than imported: requiring book.js from this module would re-run
// its own app.http() registration a second time, and this is a tiny, pure, no-I/O helper — same
// "mirrored, not imported, so this module stays self-contained" precedent already established by
// src/functions/account/me.js's PROFILE_FIELDS (see that file's header comment).
function referencePhotoUrlPrefix() {
  const endpoint = process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT;
  if (!endpoint) return null;
  const container = process.env.INSPIRATION_PHOTOS_CONTAINER || 'inspiration-photos';
  return `${endpoint.replace(/\/+$/, '')}/${container}/`;
}

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be JSON'];

  if (!body.customerName || typeof body.customerName !== 'string' || !body.customerName.trim()) {
    errors.push('customerName is required');
  }
  if (!body.customerPhone || typeof body.customerPhone !== 'string' || !body.customerPhone.trim()) {
    errors.push('customerPhone is required');
  }
  if (!body.customerEmail || typeof body.customerEmail !== 'string' || !EMAIL_RE.test(body.customerEmail)) {
    errors.push('customerEmail is required and must look like an email address');
  }
  if (!LACE_STYLES.includes(body.laceStyle)) {
    errors.push(`laceStyle is required and must be one of: ${LACE_STYLES.join(', ')}`);
  }
  if (body.capSize !== undefined && body.capSize !== null && body.capSize !== '' && !CAP_SIZES.includes(body.capSize)) {
    errors.push(`capSize must be one of: ${CAP_SIZES.join(', ')}`);
  }
  // Every measurement is individually optional — a customer is never forced to already own a
  // measuring tape before they can express interest; staff follow up either way (see the `status`
  // workflow on db/schema.sql's custom_wig_orders). Whatever subset is actually submitted just gets
  // bounds-checked.
  for (const [jsonKey] of MEASUREMENT_FIELDS) {
    const raw = body[jsonKey];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= MIN_MEASUREMENT_IN || n > MAX_MEASUREMENT_IN) {
      errors.push(`${jsonKey} must be a number greater than ${MIN_MEASUREMENT_IN} and at most ${MAX_MEASUREMENT_IN} (inches)`);
    }
  }
  if (body.styleNotes !== undefined && body.styleNotes !== null && typeof body.styleNotes !== 'string') {
    errors.push('styleNotes must be a string');
  }
  if (body.referencePhotoUrl !== undefined && body.referencePhotoUrl !== null && body.referencePhotoUrl !== '') {
    if (typeof body.referencePhotoUrl !== 'string') {
      errors.push('referencePhotoUrl must be a string');
    } else {
      const prefix = referencePhotoUrlPrefix();
      if (!prefix || !body.referencePhotoUrl.startsWith(prefix)) {
        errors.push('referencePhotoUrl must be a URL from this site\'s inspiration-photos upload endpoint');
      }
    }
  }
  return errors;
}

async function customWigOrderHandler(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const errors = validateBody(body);
  if (errors.length) {
    return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };
  }

  // Same soft, never-throwing lookup book.js uses: a missing/invalid/expired cookie, or
  // CUSTOMER_SESSION_SECRET being unconfigured, just resolves to null (a guest order) rather than
  // failing the request.
  const customerId = optionalCustomerId(request);

  const measurementValues = MEASUREMENT_FIELDS.map(([jsonKey]) => {
    const raw = body[jsonKey];
    return raw === undefined || raw === null || raw === '' ? null : Number(raw);
  });

  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO custom_wig_orders
         (customer_name, customer_phone, customer_email, customer_id,
          circumference_in, front_to_nape_in, ear_to_ear_forehead_in, ear_to_ear_top_in,
          temple_to_temple_in, nape_of_neck_in, cap_size, lace_style, style_notes, reference_photo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${ORDER_COLUMNS}`,
      [
        body.customerName.trim(),
        // Normalized, not just trimmed — same reasoning as book.js's INSERT: matches whatever shape
        // this same phone number normalizes to everywhere else in the app.
        normalizePhone(body.customerPhone),
        body.customerEmail.trim(),
        customerId,
        ...measurementValues,
        body.capSize || null,
        body.laceStyle,
        body.styleNotes ? String(body.styleNotes).trim() || null : null,
        body.referencePhotoUrl ? body.referencePhotoUrl.trim() : null,
      ]
    );

    const order = rows[0];

    // Confirmation emails — log-not-fail, order row is already committed/source of truth. See
    // lib/email.js's sendCustomWigOrderConfirmations for the failure-isolation guarantee.
    await sendCustomWigOrderConfirmations(order);

    return { status: 201, jsonBody: { order } };
  } catch (err) {
    context.error('POST /api/custom-wig-order failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('customWigOrder', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'custom-wig-order',
  handler: customWigOrderHandler,
});

module.exports = {
  customWigOrderHandler,
  validateBody,
  referencePhotoUrlPrefix,
  MEASUREMENT_FIELDS,
  LACE_STYLES,
  CAP_SIZES,
  MIN_MEASUREMENT_IN,
  MAX_MEASUREMENT_IN,
};
