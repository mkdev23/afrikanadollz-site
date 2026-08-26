// Hand-rolled admin session auth, per the plan: a single shared password (ADMIN_PASSWORD) gates a
// signed, expiring session cookie. No framework/library — a single-operator salon doesn't need real
// user accounts, just "did this request present a cookie we signed and that hasn't expired yet."
//
// Token shape: `${base64url(JSON.stringify({exp,epoch}))}.${base64url(hmac-sha256(payloadB64, secret))}`
// verifySession recomputes the HMAC over the received payload and compares with
// crypto.timingSafeEqual (constant-time, so a failed comparison can't leak timing information about
// the secret/signature), then checks the embedded `exp` and `epoch`. The payload carries nothing but
// an expiry and an epoch number — there's only one admin, so there's no identity to encode.
//
// `epoch` (added for session revocation — see db/schema.sql's admin_account.session_epoch comment)
// is the admin_account row's session_epoch value at the moment the token was signed. verifySession is
// pure/synchronous like the rest of this file's crypto helpers — it takes the *current* epoch as a
// parameter rather than fetching it itself, so it stays trivially unit-testable with no DB involved.
// The DB round-trip lives in requireAdmin() below (now async, and requiring a `db` handle from
// callers), which is the one place per-request verification actually happens: it looks up
// admin_account's current session_epoch and passes it in. This is what makes a password reset (which
// bumps session_epoch) instantly invalidate every previously-issued session cookie, no matter how
// fresh — the cookie's baked-in epoch simply stops matching the row's current one.
'use strict';

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'afd_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — a working shift, not "forever"

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function fromB64url(input) {
  return Buffer.from(input, 'base64url');
}

/**
 * Sign a fresh session token good for SESSION_TTL_MS from the moment it's called.
 * @param {string} secret - ADMIN_SESSION_SECRET
 * @param {number} epoch - admin_account.session_epoch's value *right now* (fetched by the caller —
 *   see src/functions/admin/login.js). Baked into the payload so a later password reset (which bumps
 *   the stored epoch) can invalidate this exact token by making it stop matching, without needing any
 *   session store — see this file's header comment.
 * @param {number} [ttlMs] - override the default TTL (mainly for tests)
 * @returns {string} opaque cookie value
 */
function signSession(secret, epoch, ttlMs) {
  if (!secret) throw new Error('signSession: secret is required');
  if (!Number.isInteger(epoch)) throw new Error('signSession: epoch is required');
  const payload = JSON.stringify({
    epoch,
    exp: Date.now() + (typeof ttlMs === 'number' ? ttlMs : SESSION_TTL_MS),
  });
  const payloadB64 = b64url(payload);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * Verify a session token. Returns true if the signature checks out, it hasn't expired, AND its
 * embedded epoch matches `currentEpoch` (admin_account's *current* session_epoch — see this file's
 * header comment), false for every other case (missing/malformed/tampered/wrong-secret/expired/
 * superseded-by-a-password-reset) — callers never need to distinguish why, they just gate on the
 * boolean, exactly as before epoch checking was added.
 * @param {string} token
 * @param {string} secret
 * @param {number} currentEpoch - admin_account.session_epoch's current value; pass whatever the DB
 *   has right now, not a cached/stale value, or a reset won't actually revoke anything.
 */
function verifySession(token, secret, currentEpoch) {
  if (!token || !secret || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  let expectedSig;
  let providedSig;
  try {
    expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    providedSig = fromB64url(sigB64);
  } catch {
    return false;
  }
  if (expectedSig.length !== providedSig.length) return false;
  if (!crypto.timingSafeEqual(expectedSig, providedSig)) return false;

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return false;
  }
  if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return false;
  if (typeof currentEpoch !== 'number' || payload.epoch !== currentEpoch) return false;
  return true;
}

/** Parse a raw `Cookie` request header into a { name: value } map. */
function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) return;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  });
  return out;
}

/**
 * Shared guard for every /api/staffconsole/* endpoint except login itself. Reads the session cookie off
 * `request`, verifies it against ADMIN_SESSION_SECRET AND admin_account's *current* session_epoch (see
 * this file's header comment), and returns a small result object — handlers just check `.ok` and,
 * when false, return `{ status: result.status, jsonBody: result.jsonBody }` verbatim. Kept as a plain
 * function rather than framework middleware to match this project's existing thin-handler style (see
 * src/functions/*.js) — Azure Functions v4's hooks API would add ceremony for what's a few-line check.
 *
 * Now async and requires a `db` handle (every caller already has one via its own module-level
 * getPool()) because checking the *live* epoch is unavoidably a DB round trip — a cached/stale epoch
 * would defeat the whole point of instant revocation on password reset. The DB is only ever touched
 * when a session cookie is actually present: a request with no cookie at all still short-circuits to
 * 401 with zero I/O, exactly as before this change.
 * @param {import('@azure/functions').HttpRequest} request
 * @param {{query: Function}} db - a pg Pool (or anything with a compatible .query)
 */
async function requireAdmin(request, db) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      jsonBody: { error: 'Admin auth is not configured (ADMIN_SESSION_SECRET missing).' },
    };
  }
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return { ok: false, status: 401, jsonBody: { error: 'Not authenticated.' } };
  }

  let currentEpoch = null;
  try {
    const { rows } = await db.query('SELECT session_epoch FROM admin_account WHERE id = 1');
    currentEpoch = rows[0] ? rows[0].session_epoch : null;
  } catch {
    currentEpoch = null;
  }
  if (currentEpoch === null || !verifySession(token, secret, currentEpoch)) {
    return { ok: false, status: 401, jsonBody: { error: 'Not authenticated.' } };
  }
  return { ok: true };
}

/**
 * Azure Functions v4 `HttpResponseInit.cookies[]` descriptor for a fresh login.
 * @param {string} secret - ADMIN_SESSION_SECRET
 * @param {number} epoch - admin_account.session_epoch's current value, read by the caller at login
 *   time (see src/functions/admin/login.js) — see signSession()'s JSDoc for why this is required.
 */
function buildSessionCookie(secret, epoch) {
  return {
    name: SESSION_COOKIE_NAME,
    value: signSession(secret, epoch),
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Same cookie descriptor shape, but expiring it immediately (for logout). */
function clearSessionCookie() {
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

// ============================================================================
// Password hashing (added for the admin self-service password-reset feature — see
// db/schema.sql's admin_account table). crypto.scrypt is Node's built-in password-hashing KDF, so
// this needs no new dependency (bcrypt/argon2 would be the usual choice elsewhere, but this project
// has deliberately stayed dependency-light — see package.json). Stored shape is
// `scrypt:<saltHex>:<derivedKeyHex>` — a self-describing format (a prefix tag rather than assuming
// every future admin_account.password_hash row is scrypt forever) with a fresh random salt per hash,
// same rationale as this file's session HMACs: never compare/store secrets without per-use
// randomness where it's cheap to add. Deliberately synchronous (scryptSync, not the async/promisified
// form) to match this codebase's existing synchronous crypto style (createHmac, timingSafeEqual
// above) — an admin login/reset is a rare, single-operator operation, not a hot path, so blocking the
// event loop for the ~100ms a scrypt hash takes is an acceptable trade for the simpler code.
// ============================================================================

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/**
 * Hash a plaintext password for storage in admin_account.password_hash.
 * @param {string} password
 * @returns {string} `scrypt:<saltHex>:<derivedKeyHex>`
 */
function hashPassword(password) {
  if (typeof password !== 'string' || !password) {
    throw new Error('hashPassword: password is required');
  }
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored hashPassword() value. Returns false (never throws)
 * for any malformed/foreign-format stored value, matching verifySession's "every failure mode just
 * looks like false" contract.
 */
function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || !password || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, keyHex] = parts;
  let salt;
  let expected;
  let actual;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(keyHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    actual = crypto.scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * SHA-256 of an admin password-reset token, hex-encoded — the same "never store the raw secret"
 * discipline as lib/customerAuth.js's hashChallengeSecret, applied to admin_password_resets.
 * Kept as its own function (rather than importing customerAuth's) so this file's admin-domain
 * concerns don't reach into the customer-domain module for a one-line hash.
 */
function hashResetToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Constant-time compare of a caller-supplied raw reset token against a stored token_hash. */
function resetTokenMatches(rawToken, storedHash) {
  const candidate = Buffer.from(hashResetToken(rawToken), 'hex');
  let expected;
  try {
    expected = Buffer.from(String(storedHash || ''), 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  signSession,
  verifySession,
  parseCookieHeader,
  requireAdmin,
  buildSessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  hashResetToken,
  resetTokenMatches,
};
