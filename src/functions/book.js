// POST /api/book — creates an appointment, then fires both confirmation emails (customer + business)
// via Azure Communication Services Email. Email sending is log-not-fail per the plan: the DB row is
// the source of truth, so an email error never turns a successful booking into an error response.
//
// Ported from the original Vercel-style api/book.js to the Azure Functions Node.js v4 programming
// model: identical DB/transaction/advisory-lock logic (see the big comment below, preserved
// verbatim from the prior version — nothing about the race-condition guard changed in the port).
// What changed is purely how the request body is read (`await request.json()` instead of `req.body`)
// and how the response is produced (returning `{status, jsonBody}` instead of calling `res.status().json()`).
// See src/functions/services.js's header comment for the one behavioral difference on wrong-method
// requests (404 via Azure's router instead of an explicit 405 body) — moot here since POST is the
// only method registered anyway.
'use strict';

const crypto = require('crypto');
const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { computeSlots, localDateStringInZone } = require('../../lib/availability');
const { sendBookingConfirmations } = require('../../lib/email');
const { optionalCustomerId } = require('../../lib/customerAuth');
const { verifyPaymentSucceeded } = require('../../lib/stripe');
const { normalizePhone } = require('../../lib/phone');
// DEPOSIT_AMOUNT_CENTS lives in payments/depositIntent.js (the endpoint that actually creates the
// PaymentIntent a customer pays) — imported, never redefined, so the amount verified here can never
// drift from the amount actually charged.
const { DEPOSIT_AMOUNT_CENTS } = require('./payments/depositIntent');

const TIMEZONE = 'America/New_York';

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Additive: booking can optionally carry the URL returned by a prior
// POST /api/upload-inspiration-photo call (src/functions/uploadInspirationPhoto.js). That URL is never
// trusted verbatim -- it must actually point into the inspiration-photos blob container this app
// controls, checked here as a plain prefix match against INSPIRATION_PHOTOS_BLOB_ENDPOINT (set in
// infra/main.bicep from the storage account's real primary blob endpoint) + the configured container
// name, so an arbitrary client-supplied URL (e.g. pointing at some other site, or used to smuggle a
// data: URL into storage/notifications) can never be persisted as this appointment's photo.
function inspirationPhotoUrlPrefix() {
  const endpoint = process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT;
  if (!endpoint) return null;
  const container = process.env.INSPIRATION_PHOTOS_CONTAINER || 'inspiration-photos';
  return `${endpoint.replace(/\/+$/, '')}/${container}/`;
}

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be JSON'];

  if (!/^\d+$/.test(String(body.serviceId))) errors.push('serviceId is required and must be an integer');
  if (!body.customerName || typeof body.customerName !== 'string' || !body.customerName.trim()) {
    errors.push('customerName is required');
  }
  if (!body.customerPhone || typeof body.customerPhone !== 'string' || !body.customerPhone.trim()) {
    errors.push('customerPhone is required');
  }
  if (!body.customerEmail || typeof body.customerEmail !== 'string' || !EMAIL_RE.test(body.customerEmail)) {
    errors.push('customerEmail is required and must look like an email address');
  }
  if (!body.start || Number.isNaN(Date.parse(body.start))) {
    errors.push('start is required and must be a valid ISO-8601 datetime');
  }
  if (body.smsOptIn && (!body.smsPhone || typeof body.smsPhone !== 'string' || !body.smsPhone.trim())) {
    errors.push('smsPhone is required when smsOptIn is true');
  }
  if (body.inspirationPhotoUrl !== undefined && body.inspirationPhotoUrl !== null && body.inspirationPhotoUrl !== '') {
    if (typeof body.inspirationPhotoUrl !== 'string') {
      errors.push('inspirationPhotoUrl must be a string');
    } else {
      const prefix = inspirationPhotoUrlPrefix();
      if (!prefix || !body.inspirationPhotoUrl.startsWith(prefix)) {
        errors.push('inspirationPhotoUrl must be a URL from this site\'s inspiration-photos upload endpoint');
      }
    }
  }
  // Additive/optional: the id of a PaymentIntent the client already confirmed via Stripe.js for the
  // $20 deposit (src/functions/payments/depositIntent.js). Only a shape check here — whether it
  // actually succeeded and is for the right amount is verified server-side against Stripe's own API
  // inside the transaction below (verifyPaymentSucceeded), never trusted at face value. Omitting this
  // field entirely is the default, pre-Stripe path: the deposit stays manual/off-app via Cash App.
  if (body.paymentIntentId !== undefined && body.paymentIntentId !== null && body.paymentIntentId !== '') {
    if (typeof body.paymentIntentId !== 'string') {
      errors.push('paymentIntentId must be a string');
    }
  }
  return errors;
}

async function bookHandler(request, context) {
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

  const serviceId = Number(body.serviceId);
  const requestedStart = new Date(body.start);
  if (requestedStart.getTime() <= Date.now()) {
    return { status: 400, jsonBody: { error: 'start must be in the future' } };
  }

  const db = getPool();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Race-condition guard: a single Postgres session-scoped advisory lock keyed by the requested
    // LOCAL calendar day, held for the duration of this transaction (pg_advisory_xact_lock auto-
    // releases on COMMIT/ROLLBACK). Two customers racing for slots on the same day are fully
    // serialized against each other here, so the read-then-insert below can't produce a double-book.
    //
    // Why this over a bare "SELECT ... FOR UPDATE" or a SERIALIZABLE transaction:
    // - Plain "SELECT ... FOR UPDATE" only locks rows that already exist. Two concurrent
    //   transactions booking the same brand-new slot would both run the overlap SELECT, both see
    //   zero conflicting rows (nothing to lock), both pass, and both insert — a classic phantom-read
    //   double-book that row-level locking alone cannot prevent.
    // - A SERIALIZABLE transaction *would* catch this, but only by aborting one transaction with a
    //   40001 serialization-failure error after the fact, which pushes retry logic into every caller
    //   and does needless work (both transactions run to the insert before Postgres tells one it lost).
    // - The advisory lock prevents the conflict from ever being possible in the first place: it's
    //   effectively a mutex per business-day, cheap, requires no retry loop, and its scope (a whole
    //   day, not just the specific overlapping range) is intentionally conservative — this is a
    //   single-operator salon, so nothing is lost by fully serializing bookings within one day.
    const localDay = localDateStringInZone(requestedStart, TIMEZONE);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`booking:${localDay}`]);

    const { rows: serviceRows } = await client.query(
      'SELECT id, name, duration_min, buffer_min FROM services WHERE id = $1 AND active = true',
      [serviceId]
    );
    if (serviceRows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 404, jsonBody: { error: 'Service not found' } };
    }
    const service = serviceRows[0];
    const requestedEnd = new Date(requestedStart.getTime() + service.duration_min * 60000);

    // Re-validate against fresh data, using the exact same pure slot logic /api/availability.js
    // uses, so "was this slot offered" and "is this slot still free" can never drift apart.
    const { rows: blocks } = await client.query(
      `SELECT start_at, end_at FROM blocked_slots
       WHERE start_at < ($2::date + interval '1 day') AND end_at > ($1::date - interval '1 day')`,
      [localDay, localDay]
    );
    const { rows: appointments } = await client.query(
      `SELECT start_at, end_at FROM appointments
       WHERE status = 'confirmed'
         AND start_at < ($2::date + interval '1 day') AND end_at > ($1::date - interval '1 day')`,
      [localDay, localDay]
    );
    const { rows: rules } = await client.query(
      'SELECT weekday, start_time, end_time FROM availability_rules'
    );

    const [day] = computeSlots(
      rules, blocks, appointments,
      service.duration_min, service.buffer_min,
      { from: localDay, to: localDay },
      TIMEZONE
    );

    const stillAvailable = day.slots.some(
      (s) => s.start === requestedStart.toISOString() && s.end === requestedEnd.toISOString()
    );
    if (!stillAvailable) {
      await client.query('ROLLBACK');
      return { status: 409, jsonBody: { error: 'That slot is no longer available. Please pick another.' } };
    }

    const manageToken = crypto.randomBytes(24).toString('base64url');
    const smsOptIn = Boolean(body.smsOptIn);

    // Optional account linkage (additive, customer-accounts feature): if this request carries a
    // valid customer session cookie, attach that customer_id to the new appointment so it shows up
    // in their account history/billing later. optionalCustomerId() never throws and resolves to null
    // for a missing/invalid/expired cookie or unconfigured CUSTOMER_SESSION_SECRET — booking still
    // requires no account either way, exactly as before this feature existed.
    const customerId = optionalCustomerId(request);

    // Optional card deposit (additive): if the client already collected the $20 deposit via Stripe.js
    // client-side and got back a PaymentIntent id, verify — server-side, against Stripe's own API via
    // verifyPaymentSucceeded, never trusting a client-reported success flag — that it actually
    // succeeded and is for the expected deposit amount BEFORE creating the appointment. Doing this
    // ahead of the INSERT (and rolling back on failure) means a failed/mismatched verification can
    // never result in an unpaid appointment that claims to be paid. Omitting paymentIntentId is the
    // default, pre-Stripe path — behaves exactly as before this feature existed.
    const paymentIntentId = body.paymentIntentId ? body.paymentIntentId.trim() : null;
    if (paymentIntentId) {
      try {
        await verifyPaymentSucceeded(paymentIntentId, { expectedAmountCents: DEPOSIT_AMOUNT_CENTS });
      } catch (err) {
        await client.query('ROLLBACK');
        context.warn('POST /api/book: deposit payment verification failed:', err.message);
        return {
          status: 402,
          jsonBody: {
            error: 'We could not verify your card payment. Please try again, or pay the deposit via Cash App instead.',
          },
        };
      }
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO appointments
         (service_id, customer_name, customer_phone, customer_email, notes,
          start_at, end_at, status, sms_opt_in, sms_phone, manage_token, customer_id, inspiration_photo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, $9, $10, $11, $12)
       RETURNING id, service_id, customer_name, customer_phone, customer_email, notes,
                 start_at, end_at, status, sms_opt_in, sms_phone, manage_token, customer_id,
                 inspiration_photo_url, created_at`,
      [
        serviceId,
        body.customerName.trim(),
        // Normalized (not just trimmed) so this matches, character-for-character, whatever
        // src/functions/auth/auth.js's retroactive guest-appointment linking compares against once
        // this same person later verifies by phone — see lib/phone.js's header comment for why plain
        // string equality on an unnormalized phone number silently fails to link a real match.
        normalizePhone(body.customerPhone),
        body.customerEmail.trim(),
        body.notes ? String(body.notes).trim() : null,
        requestedStart.toISOString(),
        requestedEnd.toISOString(),
        smsOptIn,
        smsOptIn ? body.smsPhone.trim() : null,
        manageToken,
        customerId,
        body.inspirationPhotoUrl ? body.inspirationPhotoUrl.trim() : null,
      ]
    );

    // A verified card deposit gets recorded in the same transaction as the appointment it belongs to
    // — either both commit together or neither does, so a billing_entries row can never exist for an
    // appointment that failed to get created (or vice versa). customer_id mirrors the appointment's
    // own resolved value, same pattern as src/functions/admin/billing.js's manual-entry insert.
    if (paymentIntentId) {
      await client.query(
        `INSERT INTO billing_entries (appointment_id, customer_id, amount_cents, method, source, external_ref, recorded_by)
         VALUES ($1, $2, $3, 'card', 'stripe', $4, 'stripe')`,
        [inserted[0].id, customerId, DEPOSIT_AMOUNT_CENTS, paymentIntentId]
      );
    }

    await client.query('COMMIT');

    // Step 2: confirmation emails (Azure Communication Services Email) — log-not-fail, DB row is
    // source of truth. sendBookingConfirmations() never throws (see lib/email.js), so a delivery
    // failure here can't turn this into a 500 for a booking that already succeeded.
    await sendBookingConfirmations(inserted[0], service);

    return { status: 201, jsonBody: { appointment: inserted[0] } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    context.error('POST /api/book failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  } finally {
    client.release();
  }
}

app.http('book', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'book',
  handler: bookHandler,
});

module.exports = { bookHandler, validateBody, inspirationPhotoUrlPrefix };
