// Customer session auth — the same hand-rolled signed-cookie mechanics as lib/adminAuth.js (HMAC-
// SHA256, crypto.timingSafeEqual, Azure Functions v4's native `cookies[]` response descriptors), kept
// as a parallel module rather than folding into adminAuth.js because the two payloads mean different
// things: an admin session carries no identity (there's only one admin), while a customer session
// must carry *which* customer is signed in. Reuses adminAuth.js's parseCookieHeader() rather than
// re-implementing cookie parsing — that part of the mechanics is identical and already correct.
//
// Backs both a hard guard (requireCustomer, for /api/account/*) and a soft, never-throwing lookup
// (optionalCustomerId, for src/functions/book.js) — a booking must never fail just because a session
// cookie is missing, malformed, or expired; it should just fall back to "guest booking" exactly as it
// worked before this feature existed.
//
// Also hosts the magic-link/OTP challenge-secret hashing helpers (hashChallengeSecret /
// challengeSecretMatches) used by src/functions/auth/auth.js — kept here rather than a separate file
// since they're the same "prove possession of a secret without ever storing it in the clear" concern
// as the session tokens above, just applied to a shorter-lived secret.
'use strict';

const crypto = require('crypto');
const { parseCookieHeader } = require('./adminAuth');

const SESSION_COOKIE_NAME = 'afd_customer_session';
// 90 days, not the admin's 12-hour "one shift" window — a customer account exists to be checked back
// into weeks after a visit (appointment history, billing), and there's nothing more sensitive gated
// behind it than what /api/account/* already scopes server-side to this one customer_id. Was 30 days;
// widened after user complaints about having to re-verify (magic link / OTP) too often — paired with
// a sliding refresh (src/functions/account/me.js's accountMeHandler reissues a fresh cookie on every
// successful check) rather than just a longer flat TTL alone, since GET /api/account/me is the one
// choke point almost every customer-facing page load already passes through (account.html on load,
// book.html's header "Hi, X" indicator) — so anyone who visits at least once every 90 days effectively
// never sees the login screen again, while someone truly inactive that long still re-verifies once,
// which is reasonable. No password/remember-me-checkbox was added alongside this — see the commit this
// shipped in for why (kept deliberately passwordless; this alone was judged to fix the actual
// complaint without reopening that tradeoff).
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function fromB64url(input) {
  return Buffer.from(input, 'base64url');
}

/**
 * Sign a fresh customer session token good for SESSION_TTL_MS, identifying `customerId`.
 * @param {number} customerId
 * @param {string} secret - CUSTOMER_SESSION_SECRET
 * @param {number} [ttlMs] - override the default TTL (mainly for tests)
 */
function signCustomerSession(customerId, secret, ttlMs) {
  if (!secret) throw new Error('signCustomerSession: secret is required');
  if (!Number.isInteger(customerId)) throw new Error('signCustomerSession: customerId must be an integer');
  const payload = JSON.stringify({
    cid: customerId,
    exp: Date.now() + (typeof ttlMs === 'number' ? ttlMs : SESSION_TTL_MS),
  });
  const payloadB64 = b64url(payload);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * Verify a customer session token. Returns `{ customerId, exp }` on success, `null` for every other
 * case (missing/malformed/tampered/wrong-secret/expired) — mirrors adminAuth.verifySession's
 * boolean-only contract except it also needs to hand back *which* customer, hence the object.
 */
function verifyCustomerSession(token, secret) {
  if (!token || !secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  let expectedSig;
  let providedSig;
  try {
    expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    providedSig = fromB64url(sigB64);
  } catch {
    return null;
  }
  if (expectedSig.length !== providedSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, providedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return null;
  if (!Number.isInteger(payload.cid)) return null;
  return { customerId: payload.cid, exp: payload.exp };
}

/**
 * Shared guard for /api/account/* endpoints. Reads the session cookie off `request`, verifies it
 * against CUSTOMER_SESSION_SECRET, and returns `{ok:true, customerId}` or `{ok:false, status,
 * jsonBody}` — same calling convention as adminAuth.requireAdmin().
 * @param {import('@azure/functions').HttpRequest} request
 */
function requireCustomer(request) {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      jsonBody: { error: 'Customer auth is not configured (CUSTOMER_SESSION_SECRET missing).' },
    };
  }
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  const result = verifyCustomerSession(token, secret);
  if (!result) return { ok: false, status: 401, jsonBody: { error: 'Not authenticated.' } };
  return { ok: true, customerId: result.customerId };
}

/**
 * Soft variant used by src/functions/book.js: resolves the customer_id to link a fresh booking to,
 * if any, but NEVER fails the request — missing config, no cookie, or an invalid/expired one all
 * just resolve to `null` (a guest booking), exactly as bookings worked before this feature existed.
 * @param {import('@azure/functions').HttpRequest} request
 * @returns {number|null}
 */
function optionalCustomerId(request) {
  try {
    const secret = process.env.CUSTOMER_SESSION_SECRET;
    if (!secret) return null;
    const cookies = parseCookieHeader(request.headers.get('cookie'));
    const token = cookies[SESSION_COOKIE_NAME];
    const result = verifyCustomerSession(token, secret);
    return result ? result.customerId : null;
  } catch {
    return null;
  }
}

/** Azure Functions v4 `HttpResponseInit.cookies[]` descriptor for a fresh customer login. */
function buildCustomerSessionCookie(customerId, secret) {
  return {
    name: SESSION_COOKIE_NAME,
    value: signCustomerSession(customerId, secret),
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Same cookie descriptor shape, but expiring it immediately (for logout). */
function clearCustomerSessionCookie() {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 0,
  };
}

/**
 * SHA-256 of a magic-link token or OTP code, hex-encoded. auth_challenges.secret_hash stores only
 * this, never the raw secret, so a DB read (backup, leaked snapshot, replica, etc.) can't be replayed
 * as a login the way a stored raw token/code could be.
 */
function hashChallengeSecret(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Constant-time compare of a caller-supplied raw secret against a stored `secret_hash`. Both sides
 * are fixed-length hex digests once hashed, so a length mismatch only occurs on malformed/corrupt
 * input — timingSafeEqual requires equal-length buffers, hence the explicit length check first.
 */
function challengeSecretMatches(rawSecret, storedHash) {
  const candidate = Buffer.from(hashChallengeSecret(rawSecret), 'hex');
  let expected;
  try {
    expected = Buffer.from(String(storedHash || ''), 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * A friendly, stable customer-facing identifier, e.g. `AFD-000123` for customers.id = 123.
 * Deliberately computed at read time from the DB id rather than stored as its own column: the raw
 * `id` is already a permanent, unique, sequential integer the moment a customers row exists, so
 * `'AFD-' + id` zero-padded is always in sync with zero migration/backfill risk — there's no way for
 * a computed value to drift from a stored one it's directly derived from. Six digits (comfortably
 * room for 999,999 accounts) mirrors the shape in the "AFD-000123" example from the brief; if the
 * salon ever needs more than that many customers this can widen the padding, still with no data
 * migration, since nothing is stored.
 * @param {number} id - customers.id
 * @returns {string}
 */
function formatCustomerNumber(id) {
  return 'AFD-' + String(id).padStart(6, '0');
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  signCustomerSession,
  verifyCustomerSession,
  requireCustomer,
  optionalCustomerId,
  buildCustomerSessionCookie,
  clearCustomerSessionCookie,
  hashChallengeSecret,
  challengeSecretMatches,
  formatCustomerNumber,
};
