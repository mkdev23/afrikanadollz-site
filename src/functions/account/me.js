// GET /api/account/me — the logged-in customer's basic info, or 401 if there's no valid session.
// account.html calls this on load to decide whether to show the login screen or the account view
// (and book.html/book.js's header calls it to show a lightweight "Hi, X" indicator). customer_id
// always comes from the verified session cookie via requireCustomer() — never trusted from the
// client — same pattern as every other /api/account/* handler in this folder. The returned
// `customer` always carries a `number` (e.g. "AFD-000123") computed at read time from `id` via
// lib/customerAuth.js's formatCustomerNumber — see that function's comment for why this is derived
// rather than stored.
//
// Also reissues a fresh session cookie (a full new SESSION_TTL_MS, not just extending the existing
// exp) on every successful check — a sliding-expiration "remember me", added after user complaints
// about having to re-verify (magic link / OTP) too often. This is the one handler to do it in rather
// than every /api/account/* route: this GET is the choke point almost every customer-facing page load
// already passes through first (see above), so refreshing here covers real usage without needing the
// same change repeated across account/appointments.js, account/billing.js, etc. Safe to do
// unconditionally on every call — re-signing is cheap, and sliding the window forward on every
// successful authenticated request is the standard shape for this pattern.
//
// PATCH /api/account/me — body may include `name` and/or any of the self-reported hair-profile
// fields (hair_type, hair_texture, allergies, preferences), all optional/partial-patch — any
// combination in one call, any field omitted is left unchanged. `name` was added for the
// explicit-signup flow in src/functions/auth/auth.js: a brand-new customer's row is created at
// /api/auth/verify time with no name yet (verifying only proves they own the email/phone, not what
// to call them), and account.html's post-verify "welcome, let's create your account" step calls this
// once to collect it before treating signup as complete. Nothing stops an existing customer from
// calling this to update their name later too — there's no reason to special-case that. `name` keeps
// its own "required, non-blank when present" validation (unchanged from before); the four profile
// fields are the same self-reported, free-text, no-enum category of data as src/functions/admin/
// clients.js's staff-side PROFILE_FIELDS/buildProfileUpdate (same column set, same partial-patch and
// trim/clear semantics: a present field is trimmed, empty string or explicit null clears it to null,
// an absent field is left untouched) — mirrored here rather than imported so this customer-facing
// module stays self-contained, same as every other src/functions/*.js file in this codebase. This is
// a *different*, safe category of data from client_notes (see db/schema.sql's comment above the
// ALTER TABLE lines that added these columns): customers here only ever read/write their own
// self-disclosed info about themselves, scoped by auth.customerId, never client_notes.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireCustomer, formatCustomerNumber, buildCustomerSessionCookie } = require('../../../lib/customerAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const PROFILE_FIELDS = ['hair_type', 'hair_texture', 'allergies', 'preferences'];

function withCustomerNumber(row) {
  return row ? { ...row, number: formatCustomerNumber(row.id) } : null;
}

async function accountMeHandler(request, context) {
  const auth = requireCustomer(request);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, name, email, phone, hair_type, hair_texture, allergies, preferences, created_at FROM customers WHERE id = $1',
      [auth.customerId]
    );
    if (rows.length === 0) {
      // Session cookie verified fine but the customer row is gone (shouldn't normally happen) —
      // treat it the same as "not authenticated" rather than exposing an inconsistent-state error.
      return { status: 401, jsonBody: { error: 'Not authenticated.' } };
    }
    // Sliding refresh (see this file's header comment) — requireCustomer() already proved the
    // presented cookie is valid, so it's safe to hand back a brand-new one good for another full
    // SESSION_TTL_MS. CUSTOMER_SESSION_SECRET is guaranteed set here: requireCustomer() would already
    // have short-circuited to a 500 above if it weren't.
    const cookie = buildCustomerSessionCookie(auth.customerId, process.env.CUSTOMER_SESSION_SECRET);
    return { status: 200, jsonBody: { customer: withCustomerNumber(rows[0]) }, cookies: [cookie] };
  } catch (err) {
    context.error('GET /api/account/me failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function accountMeUpdateHandler(request, context) {
  const auth = requireCustomer(request);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  // `name`: unchanged validation from before this feature — required/non-blank whenever the key is
  // present at all, but the key itself is now optional (a profile-only PATCH omits it entirely).
  const hasName = !!(body && Object.prototype.hasOwnProperty.call(body, 'name'));
  let name = null;
  if (hasName) {
    name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { status: 400, jsonBody: { error: 'name is required' } };
  }

  // Profile fields: partial patch, same trim/clear semantics as admin/clients.js's
  // buildProfileUpdate — present + string/number => trimmed (empty string clears to null); present +
  // null/undefined => null; absent => left unchanged.
  const sets = [];
  const values = [];
  if (hasName) {
    values.push(name);
    sets.push(`name = $${values.length}`);
  }
  for (const field of PROFILE_FIELDS) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    const value = raw === null || raw === undefined ? null : String(raw).trim() || null;
    values.push(value);
    sets.push(`${field} = $${values.length}`);
  }

  if (sets.length === 0) {
    return {
      status: 400,
      jsonBody: { error: 'At least one of name, hair_type, hair_texture, allergies, preferences is required' },
    };
  }

  try {
    const db = getPool();
    values.push(auth.customerId);
    const { rows } = await db.query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, name, email, phone, hair_type, hair_texture, allergies, preferences, created_at`,
      values
    );
    if (rows.length === 0) {
      return { status: 401, jsonBody: { error: 'Not authenticated.' } };
    }
    return { status: 200, jsonBody: { customer: withCustomerNumber(rows[0]) } };
  } catch (err) {
    context.error('PATCH /api/account/me failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('accountMe', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'account/me',
  handler: accountMeHandler,
});

app.http('accountMeUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'account/me',
  handler: accountMeUpdateHandler,
});

module.exports = { accountMeHandler, accountMeUpdateHandler };
