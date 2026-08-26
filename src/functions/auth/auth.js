// POST /api/auth/request — body {method:'email'|'sms', email?|phone?}. Looks up (does NOT create) a
// `customers` row for the given email/phone, generates a fresh magic-link token (email) or 6-digit
// OTP code (sms), stores its SHA-256 hash in `auth_challenges`, and sends the raw value via
// lib/email.js / lib/sms.js. Both send helpers throw on failure (unlike lib/email.js's
// sendBookingConfirmations) — see their header comments — so a delivery failure here surfaces as a
// 500 the client can retry, rather than a false "check your email/phone" success. Rate-limited via
// lib/rateLimit.js (see OTP_RATE_LIMIT below) once the requested identifier is known and valid, before
// any send is attempted — this is an SMS/email-bombing vector otherwise, and a cost-DoS vector against
// Azure Communication Services send volume.
//
// Whether the identifier is already a known customer is surfaced to the caller as `isNewUser` in the
// response — account.html uses it to show a "welcome, let's create your account" framing instead of
// "sign in" for a first-timer. Critically, no `customers` row is created here for a brand-new
// identifier: creating an account for an email/phone nobody has proven they own yet would let anyone
// "sign up" an address that isn't theirs (and would silently spam a stranger with a magic
// link/OTP). The code/link still gets sent either way — proving possession of the identifier is
// exactly how a new signup gets confirmed — but the `customers` row itself isn't created until
// /api/auth/verify succeeds. See auth_challenges.customer_id's nullable-for-a-pending-signup comment
// in db/schema.sql for how a not-yet-real customer is represented in between these two requests.
//
// POST /api/auth/verify — body {method, email?|phone?, token?|code?}. Looks up the matching unused,
// unexpired challenge, checks the secret (constant-time), marks it used, and issues a signed customer
// session cookie via lib/customerAuth.js on success. The email flow only needs `token` (a 24-byte
// random value is unambiguous on its own — see the comment above the SELECT below); the sms/OTP flow
// requires `phone` too, since a 6-digit code alone is guessable if it weren't scoped to one identifier.
// OTP verification is attempt-limited (MAX_OTP_ATTEMPTS) per challenge — a fresh code from a new
// /api/auth/request always resets the count.
//
// If the matched challenge's customer_id is NULL (a pending signup from the paragraph above), THIS
// is the moment the `customers` row actually gets created — the code/link has now been proven to
// belong to whoever's making this request. The response's `isNewUser: true` tells account.html to
// prompt for a name (via PATCH /api/account/me — see src/functions/account/me.js) before treating
// signup as complete, rather than dropping them straight on the dashboard with a nameless account.
// This works identically whether verify was reached via the OTP form (an active request/response the
// user is sitting in front of) or via the magic-link email (the user arriving cold on account.html
// with a `?token=`, with no memory of what /api/auth/request returned) because `isNewUser` is
// re-derived here from the challenge row itself, not threaded through from the earlier request.
//
// POST /api/auth/logout — clears the session cookie. Always 200.
//
// Follows the same thin-handler / Azure Functions v4 conventions as src/functions/admin/login.js:
// plain app.http(...) registrations, {status, jsonBody} returns, try/catch around request.json()
// with a null fallback.
'use strict';

const crypto = require('crypto');
const { app } = require('@azure/functions');
const { Pool } = require('pg');
const {
  buildCustomerSessionCookie,
  clearCustomerSessionCookie,
  hashChallengeSecret,
  challengeSecretMatches,
  formatCustomerNumber,
} = require('../../../lib/customerAuth');
const { sendMagicLinkEmail } = require('../../../lib/email');
const { sendOtpSms } = require('../../../lib/sms');
const { getClientIp, enforceRateLimit, rateLimitResponse } = require('../../../lib/rateLimit');
const { normalizePhone } = require('../../../lib/phone');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

// Without a limiter, /api/auth/request is both an SMS/email-bombing vector (anyone can make this
// endpoint text or email an arbitrary identifier, repeatedly) and a cost-DoS vector against Azure
// Communication Services send volume. Two independent checks, both must pass:
//   - per-target (the specific email/phone being sent to): tight, since a real person requesting
//     their own sign-in code a handful of times in 15 minutes is normal, but a dozen+ isn't — and this
//     is what actually stops a distributed attacker rotating IPs to flood one victim's phone/email.
//   - per-IP: looser, since shared networks (offices, campuses, coffee shops) can have several
//     genuine callers behind one IP; this mainly backstops a single source hammering many different
//     identifiers rather than protecting any one victim.
const OTP_RATE_LIMIT = {
  bucket: 'otp_request',
  windowMs: 15 * 60 * 1000,
  maxAttemptsPerTarget: 4,
  maxAttemptsPerIp: 10,
};

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}
// Real canonicalization now lives in lib/phone.js, shared with src/functions/book.js's guest
// customer_phone write and src/functions/admin/clients.js's search matching — see that file's header
// comment for why (formatting-insensitive phone matching across every write/read point in the app,
// including linkOrphanGuestAppointments's retroactive-linking match below). Re-exported under this
// same local name so every existing call site in this file (and every existing import of
// `normalizePhone` from this module) keeps working unchanged.

// FLAGGED (not a launch blocker, but worth a deliberate look before relying on this in production):
// normalizePhone() above went from a plain .trim() to real E.164-ish canonicalization in the same
// change that added lib/phone.js. Any `customers.phone` row written *before* that change is stored in
// whatever shape was typed at the time (raw, trim-only) — this WHERE phone = $1 lookup (and
// createCustomerFromIdentifier's ON CONFLICT (phone) below) now compares against a freshly-normalized
// identifier, so an old-format row that doesn't happen to already equal its own normalized form won't
// be found: the person would look like a "brand-new" identifier again, and createCustomerFromIdentifier
// would insert a second customers row rather than reusing their real one. A one-time backfill
// (`UPDATE customers SET phone = <normalized> WHERE phone IS NOT NULL`, with the same care taken for
// appointments.customer_phone) would resolve this for every already-existing row; deliberately not run
// here since this task is implementation/testing only, per the "do not deploy or migrate" instruction —
// left for whoever runs db/migrate.js next.
/**
 * Look up (never create) a customers row by email or phone — used at /api/auth/request time to
 * decide `isNewUser` without creating an account for an identifier nobody's proven they own yet.
 * Returns null when no row matches.
 */
async function findExistingCustomer(db, { email, phone }) {
  if (email) {
    const { rows } = await db.query(
      'SELECT id, name, email, phone, created_at FROM customers WHERE email = $1',
      [email]
    );
    return rows[0] || null;
  }
  const { rows } = await db.query(
    'SELECT id, name, email, phone, created_at FROM customers WHERE phone = $1',
    [phone]
  );
  return rows[0] || null;
}

/**
 * Create a customers row by email or phone — called only from authVerifyHandler, only once a
 * code/link has actually been proven to belong to whoever's verifying (see this file's header
 * comment). Uses Postgres's `ON CONFLICT ... DO UPDATE SET col = EXCLUDED.col` as the standard
 * "upsert as find-or-create" idiom (rather than a plain INSERT) purely as a race-safety net: two
 * concurrent /api/auth/request calls for the same brand-new identifier each get their own pending
 * (customer_id IS NULL) challenge, and whichever one verifies first must not make the second one's
 * verify blow up on a UNIQUE violation — it should just resolve to the row the first verify created.
 * The update itself is a harmless no-op write (setting a column to the value it already conflicted
 * on).
 *
 * Note: signing in with email and later with a different phone (or vice versa) creates two separate
 * customer rows rather than merging into one identity — the same is true of a fresh browser and a
 * fresh phone/email used together. Unifying identity across both login methods for the same real
 * person is out of scope for this pass; each (email) or (phone) is its own account key for now.
 */
async function createCustomerFromIdentifier(db, { email, phone }) {
  if (email) {
    const { rows } = await db.query(
      `INSERT INTO customers (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, name, email, phone, created_at`,
      [email]
    );
    return rows[0];
  }
  const { rows } = await db.query(
    `INSERT INTO customers (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING id, name, email, phone, created_at`,
    [phone]
  );
  return rows[0];
}

async function authRequestHandler(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const method = body && body.method;
  if (method !== 'email' && method !== 'sms') {
    return { status: 400, jsonBody: { error: "method must be 'email' or 'sms'" } };
  }

  let identifier;
  if (method === 'email') {
    const email = body && typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    if (!email || !EMAIL_RE.test(email)) {
      return { status: 400, jsonBody: { error: 'A valid email address is required' } };
    }
    identifier = email;
  } else {
    const phone = body && typeof body.phone === 'string' ? normalizePhone(body.phone) : '';
    if (!phone) {
      return { status: 400, jsonBody: { error: 'A phone number is required' } };
    }
    identifier = phone;
  }

  const db = getPool();
  const ip = getClientIp(request);
  const blocked = await enforceRateLimit(db, [
    {
      bucket: OTP_RATE_LIMIT.bucket,
      identifier: `target:${identifier}`,
      windowMs: OTP_RATE_LIMIT.windowMs,
      maxAttempts: OTP_RATE_LIMIT.maxAttemptsPerTarget,
    },
    {
      bucket: OTP_RATE_LIMIT.bucket,
      identifier: `ip:${ip}`,
      windowMs: OTP_RATE_LIMIT.windowMs,
      maxAttempts: OTP_RATE_LIMIT.maxAttemptsPerIp,
    },
  ]);
  if (blocked) {
    return rateLimitResponse(blocked, 'Too many sign-in code requests. Please try again later.');
  }

  try {
    const existing = await findExistingCustomer(
      db,
      method === 'email' ? { email: identifier } : { phone: identifier }
    );
    const isNewUser = !existing;

    let rawSecret;
    let ttlMs;
    if (method === 'email') {
      rawSecret = crypto.randomBytes(24).toString('base64url');
      ttlMs = MAGIC_LINK_TTL_MS;
    } else {
      rawSecret = String(crypto.randomInt(100000, 1000000)); // 6 digits
      ttlMs = OTP_TTL_MS;
    }
    const secretHash = hashChallengeSecret(rawSecret);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    // customer_id is NULL for a brand-new identifier — no customers row exists yet to point at (see
    // this file's header comment and db/schema.sql's auth_challenges.customer_id comment).
    await db.query(
      `INSERT INTO auth_challenges (customer_id, method, identifier, secret_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [existing ? existing.id : null, method, identifier, secretHash, expiresAt]
    );

    if (method === 'email') {
      const base = process.env.SITE_BASE_URL || 'https://afrikanadollz.com';
      const link = `${base}/account.html?token=${encodeURIComponent(rawSecret)}`;
      await sendMagicLinkEmail(identifier, link);
    } else {
      await sendOtpSms(identifier, rawSecret);
    }

    return { status: 200, jsonBody: { ok: true, method, isNewUser } };
  } catch (err) {
    context.error('POST /api/auth/request failed:', err);
    return {
      status: 500,
      jsonBody: { error: 'Could not send the sign-in code right now. Please try again shortly.' },
    };
  }
}

/** Attach the read-time-computed customer_number (see lib/customerAuth.js) to a customers row. */
function withCustomerNumber(row) {
  return row ? { ...row, number: formatCustomerNumber(row.id) } : null;
}

async function loadCustomerById(db, customerId) {
  const { rows } = await db.query(
    'SELECT id, name, email, phone, created_at FROM customers WHERE id = $1',
    [customerId]
  );
  return withCustomerNumber(rows[0] || null);
}

/**
 * Retroactive guest-appointment linkage (added for the "guest never learns they could have an
 * account" gap). Runs on EVERY successful verify — not just first-time signups — because it's
 * idempotent and self-healing: a returning customer who once again booked as a guest by mistake
 * (e.g. logged out at the time) gets that appointment linked back the next time they verify, at no
 * cost if there's nothing to link.
 *
 * Matches ONLY on the specific identifier that was just cryptographically proven in *this*
 * verification (the email that a magic-link was proven to belong to, or the phone an OTP was proven
 * to belong to) — never the other field, even if it happens to also appear on some appointment row,
 * since that field was never actually proven to belong to this person in this verification. Email is
 * matched case-insensitively (`LOWER(customer_email)`) because book.js stores customer_email exactly
 * as the customer typed it at booking time (no lowercasing — see src/functions/book.js's INSERT),
 * while `identifier` here is always already-lowercased (normalizeEmail, both at /api/auth/request
 * time and via customers.email's own storage) — without the LOWER(), "Jane@X.com" typed at booking
 * would never match "jane@x.com" proven at sign-in. Phone uses a plain equality match because both
 * sides are now put through the same lib/phone.js normalizePhone() before ever reaching this query
 * (book.js's guest customer_phone write, and `identifier` here via /api/auth/request's and
 * /api/auth/verify's own normalizePhone() calls) — see db/migrate-phone-backfill.js for the one-time
 * backfill this relies on to also match rows written before this normalization existed.
 *
 * The `customer_id IS NULL` guard is load-bearing: an appointment already linked to a *different*
 * customer (e.g. a rare shared-email household, or the account was already linked some other way)
 * must never be silently reassigned.
 *
 * Deliberately its own statement, not wrapped in a transaction with the customer create/lookup
 * above: pool.query() calls in this function already aren't transactional with each other (the
 * customer-row INSERT and the auth_challenges backfill UPDATE above are two independent
 * auto-committed statements too — this isn't introducing a new pattern), and by the time this runs
 * the challenge has *already* been marked used_at by the caller in its own committed statement, so
 * the "this person is signed in" fact is already durable. Wrapping this step into that same
 * all-or-nothing unit would mean an unrelated linking hiccup could roll back — or, forced into a
 * separate transaction it doesn't belong to, could 500 — a sign-in that had already fully succeeded.
 * Instead this is best-effort: wrapped in its own try/catch so a failure here (a transient DB blip,
 * say) is logged and swallowed rather than turning a successful login into a 500. Nothing is lost by
 * that: the appointment stays exactly as unlinked as it already was, and the same idempotent UPDATE
 * runs again — with a real chance of succeeding — the next time this person verifies.
 */
async function linkOrphanGuestAppointments(db, { customerId, method, identifier }) {
  try {
    if (method === 'email') {
      await db.query(
        `UPDATE appointments SET customer_id = $1
         WHERE customer_id IS NULL AND LOWER(customer_email) = $2`,
        [customerId, identifier]
      );
    } else {
      await db.query(
        `UPDATE appointments SET customer_id = $1
         WHERE customer_id IS NULL AND customer_phone = $2`,
        [customerId, identifier]
      );
    }
    // A guest appointment can already have manual billing_entries recorded against it (admin.html's
    // Payment panel logs a payment as soon as it's received, regardless of whether the appointment is
    // linked to any account yet) — billing_entries.customer_id is set from the appointment's
    // customer_id at the moment each entry is INSERTed (src/functions/admin/billing.js), so any
    // payment logged *before* the appointment above just got linked is still sitting there with
    // customer_id NULL. GET /api/account/billing filters strictly on customer_id (see
    // src/functions/account/billing.js), so without this second sync those past payments stay
    // invisible in the customer's own billing ledger forever, even though their appointment now shows
    // up fine. Drive this off `appointments.customer_id` (not the original `identifier` match) so it
    // also catches billing_entries left behind by *any* prior linking event for this customer, not
    // just the one that just ran.
    await db.query(
      `UPDATE billing_entries be SET customer_id = $1
       FROM appointments a
       WHERE be.appointment_id = a.id AND be.customer_id IS NULL AND a.customer_id = $1`,
      [customerId]
    );
  } catch (err) {
    console.error('resolveVerifiedCustomer: retroactive guest-appointment linking failed (non-fatal, will retry on next verify):', err);
  }
}

/**
 * Turns a matched, not-yet-consumed auth_challenges row into a verified customer + `isNewUser` flag,
 * for both authVerifyHandler branches below. `customerId` is the challenge's `customer_id` (may be
 * NULL — see this file's header comment); `identifier`/`method` are what to create the customers row
 * from if so. Does NOT mark the challenge used — callers already do that with their own
 * pre-existing "mark used" query, kept untouched so it stays exactly what the existing tests pin.
 *
 * Also runs the retroactive guest-appointment linkage above for both branches (an already-existing
 * customer logging back in, and a brand-new signup) — see linkOrphanGuestAppointments's own comment
 * for why this fires unconditionally on every successful verify.
 */
async function resolveVerifiedCustomer(db, { challengeId, customerId, identifier, method }) {
  let result;
  if (customerId != null) {
    result = { customer: await loadCustomerById(db, customerId), isNewUser: false, customerId };
  } else {
    const created = await createCustomerFromIdentifier(
      db,
      method === 'email' ? { email: identifier } : { phone: identifier }
    );
    // Backfill the challenge -> customer link now that the customer actually exists, purely for an
    // audit trail (which challenge created which account) — verification itself doesn't need this.
    await db.query('UPDATE auth_challenges SET customer_id = $1 WHERE id = $2', [created.id, challengeId]);
    result = { customer: withCustomerNumber(created), isNewUser: true, customerId: created.id };
  }

  await linkOrphanGuestAppointments(db, { customerId: result.customerId, method, identifier });

  return result;
}

async function authVerifyHandler(request, context) {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret) {
    context.error('POST /api/auth/verify: CUSTOMER_SESSION_SECRET is not configured.');
    return { status: 500, jsonBody: { error: 'Customer auth is not configured.' } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const method = body && body.method;
  if (method !== 'email' && method !== 'sms') {
    return { status: 400, jsonBody: { error: "method must be 'email' or 'sms'" } };
  }

  const db = getPool();
  try {
    if (method === 'email') {
      const token = body && typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) return { status: 400, jsonBody: { error: 'token is required' } };

      // A magic-link token is a 24-byte random value — effectively unique on its own — so unlike the
      // OTP flow below, this doesn't need (and the request body doesn't require) an `email` field to
      // disambiguate. We scan currently-pending email challenges and compare hashes in constant time
      // per row; volume here is one salon's worth of concurrent sign-in attempts, not a concern.
      const { rows } = await db.query(
        `SELECT id, customer_id, identifier, secret_hash FROM auth_challenges
         WHERE method = 'email' AND used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`
      );
      const match = rows.find((r) => challengeSecretMatches(token, r.secret_hash));
      if (!match) {
        return {
          status: 401,
          jsonBody: { error: 'This link is invalid or has expired. Please request a new one.' },
        };
      }
      await db.query('UPDATE auth_challenges SET used_at = now() WHERE id = $1', [match.id]);
      const { customer, isNewUser, customerId } = await resolveVerifiedCustomer(db, {
        challengeId: match.id,
        customerId: match.customer_id,
        identifier: match.identifier,
        method: 'email',
      });
      return {
        status: 200,
        jsonBody: { ok: true, customer, isNewUser },
        cookies: [buildCustomerSessionCookie(customerId, secret)],
      };
    }

    // sms / OTP
    const phone = body && typeof body.phone === 'string' ? normalizePhone(body.phone) : '';
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (!phone || !code) return { status: 400, jsonBody: { error: 'phone and code are required' } };

    const { rows } = await db.query(
      `SELECT id, customer_id, secret_hash, attempts FROM auth_challenges
       WHERE method = 'sms' AND identifier = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    const challenge = rows[0];
    if (!challenge) {
      return {
        status: 401,
        jsonBody: { error: 'That code is invalid or has expired. Please request a new one.' },
      };
    }
    if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
      return {
        status: 429,
        jsonBody: { error: 'Too many incorrect attempts. Please request a new code.' },
      };
    }
    if (!challengeSecretMatches(code, challenge.secret_hash)) {
      await db.query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
      return { status: 401, jsonBody: { error: 'Incorrect code. Please try again.' } };
    }
    await db.query('UPDATE auth_challenges SET used_at = now() WHERE id = $1', [challenge.id]);
    const { customer, isNewUser, customerId } = await resolveVerifiedCustomer(db, {
      challengeId: challenge.id,
      customerId: challenge.customer_id,
      identifier: phone,
      method: 'sms',
    });
    return {
      status: 200,
      jsonBody: { ok: true, customer, isNewUser },
      cookies: [buildCustomerSessionCookie(customerId, secret)],
    };
  } catch (err) {
    context.error('POST /api/auth/verify failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function authLogoutHandler() {
  return { status: 200, jsonBody: { ok: true }, cookies: [clearCustomerSessionCookie()] };
}

app.http('authRequest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/request',
  handler: authRequestHandler,
});

app.http('authVerify', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/verify',
  handler: authVerifyHandler,
});

app.http('authLogout', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/logout',
  handler: authLogoutHandler,
});

module.exports = {
  authRequestHandler,
  authVerifyHandler,
  authLogoutHandler,
  findExistingCustomer,
  createCustomerFromIdentifier,
  linkOrphanGuestAppointments,
  normalizeEmail,
  normalizePhone,
  MAX_OTP_ATTEMPTS,
  OTP_RATE_LIMIT,
};
