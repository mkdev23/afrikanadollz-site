// POST /api/staffconsole/request-password-reset — body {email}. If `email` matches the registered admin
// email in admin_account, generates a fresh reset token, stores its SHA-256 hash + a 15-minute
// expiry in admin_password_resets, and emails a reset link via lib/email.js's
// sendAdminPasswordResetEmail. Always returns a generic 200 success response regardless of whether
// the email matched — same "don't leak whether an identifier is registered" discipline as every
// other auth endpoint in this codebase, applied here to the one registered admin address instead of
// a pool of customer identifiers.
//
// POST /api/staffconsole/reset-password — body {token, newPassword}. Looks up the matching unused,
// unexpired reset row (constant-time hash comparison, same approach as
// src/functions/auth/auth.js's magic-link verification), hashes newPassword with
// lib/adminAuth.js's hashPassword(), upserts it into admin_account, and marks the token used. Also
// bumps admin_account.session_epoch by 1 in that same upsert — see db/schema.sql's
// admin_account.session_epoch comment and lib/adminAuth.js's header comment for why: a password reset
// is often the direct response to a stolen session, so it needs to invalidate every already-issued
// session cookie too, not just change the password going forward.
//
// Follows the same thin-handler / Azure Functions v4 conventions as src/functions/admin/login.js:
// plain app.http(...) registrations, {status, jsonBody} returns, try/catch around request.json()
// with a null fallback. Neither endpoint is behind requireAdmin() — by design, someone who's locked
// out (forgotten password) is exactly who needs to reach these without an existing session.
// request-password-reset is rate-limited (lib/rateLimit.js) against SMS/email-bombing the admin's
// inbox — see REQUEST_RESET_RATE_LIMIT below; reset-password itself is not (the task's scope — a
// stolen/guessed token is already a 24-byte random value, effectively unbruteforceable without a
// limiter, unlike an inbox that can be flooded with real emails).
'use strict';

const crypto = require('crypto');
const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { hashPassword, hashResetToken, resetTokenMatches } = require('../../../lib/adminAuth');
const { sendAdminPasswordResetEmail } = require('../../../lib/email');
const { getClientIp, enforceRateLimit, rateLimitResponse } = require('../../../lib/rateLimit');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const RESET_TTL_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

// Unlike admin login, there IS a meaningful second identifier here: the email address the caller
// submitted. There's only one real admin inbox to bomb, but keying on the submitted address (not just
// IP) stops a distributed attacker from working around an IP-only cap to keep flooding that one inbox
// from many source IPs. The per-target cap is tight (this legitimately fires only when someone forgot
// their password, which isn't a frequent event); the per-IP cap is looser, mirroring OTP_RATE_LIMIT's
// reasoning in src/functions/auth/auth.js — shared networks (offices, campuses) can have several
// genuine callers behind one IP.
const REQUEST_RESET_RATE_LIMIT = {
  bucket: 'admin_reset_request',
  windowMs: 15 * 60 * 1000,
  maxAttemptsPerTarget: 4,
  maxAttemptsPerIp: 10,
};

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// The one always-the-same response body for request-password-reset, sent whether or not `email`
// matched admin_account.email and whether or not the send itself succeeded — see the header comment.
const GENERIC_RESPONSE = {
  status: 200,
  jsonBody: { ok: true, message: 'If that email is registered, a reset link is on its way.' },
};

async function adminRequestPasswordResetHandler(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const email = body && typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!email) return GENERIC_RESPONSE;

  const db = getPool();
  const ip = getClientIp(request);
  const blocked = await enforceRateLimit(db, [
    {
      bucket: REQUEST_RESET_RATE_LIMIT.bucket,
      identifier: `target:${email}`,
      windowMs: REQUEST_RESET_RATE_LIMIT.windowMs,
      maxAttempts: REQUEST_RESET_RATE_LIMIT.maxAttemptsPerTarget,
    },
    {
      bucket: REQUEST_RESET_RATE_LIMIT.bucket,
      identifier: `ip:${ip}`,
      windowMs: REQUEST_RESET_RATE_LIMIT.windowMs,
      maxAttempts: REQUEST_RESET_RATE_LIMIT.maxAttemptsPerIp,
    },
  ]);
  // A 429 here reveals nothing about whether `email` is the registered admin address — it's the same
  // "too many requests" response regardless of a match, so it doesn't weaken the GENERIC_RESPONSE
  // enumeration protection below.
  if (blocked) {
    return rateLimitResponse(blocked, 'Too many password reset requests. Please try again later.');
  }

  try {
    const { rows } = await db.query('SELECT email FROM admin_account WHERE id = 1');
    const registeredEmail = rows[0] && typeof rows[0].email === 'string' ? normalizeEmail(rows[0].email) : null;

    if (registeredEmail && registeredEmail === email) {
      const rawToken = crypto.randomBytes(24).toString('base64url');
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
      await db.query(
        `INSERT INTO admin_password_resets (token_hash, expires_at) VALUES ($1, $2)`,
        [tokenHash, expiresAt]
      );

      const base = process.env.SITE_BASE_URL || 'https://afrikanadollz.com';
      const resetUrl = `${base}/admin.html?resetToken=${encodeURIComponent(rawToken)}`;
      try {
        await sendAdminPasswordResetEmail(rows[0].email, resetUrl);
      } catch (err) {
        // Never let a delivery failure change the response shape — that alone could leak whether
        // the email matched (a real ACS misconfiguration should be visible in logs, not in the API).
        context.error('POST /api/staffconsole/request-password-reset: email send failed:', err);
      }
    }
  } catch (err) {
    context.error('POST /api/staffconsole/request-password-reset failed:', err);
    // Still fall through to the generic response — a DB hiccup shouldn't reveal anything either.
  }

  return GENERIC_RESPONSE;
}

async function adminResetPasswordHandler(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const token = body && typeof body.token === 'string' ? body.token.trim() : '';
  const newPassword = body && typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!token) return { status: 400, jsonBody: { error: 'token is required' } };
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      status: 400,
      jsonBody: { error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` },
    };
  }

  try {
    const db = getPool();
    // Mirrors src/functions/auth/auth.js's magic-link lookup: a reset token is a 24-byte random
    // value, unambiguous on its own, so this scans currently-pending reset rows and compares hashes
    // in constant time per row rather than needing an extra lookup column. Volume here is a single
    // admin's occasional password resets, not a concern.
    const { rows } = await db.query(
      `SELECT id, token_hash FROM admin_password_resets
       WHERE used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`
    );
    const match = rows.find((r) => resetTokenMatches(token, r.token_hash));
    if (!match) {
      return {
        status: 401,
        jsonBody: { error: 'This reset link is invalid or has expired. Please request a new one.' },
      };
    }

    const passwordHash = hashPassword(newPassword);
    // session_epoch = session_epoch + 1 on the conflict branch (an existing admin actually changing
    // their password) is the entire session-revocation mechanism — see db/schema.sql's
    // admin_account.session_epoch comment and lib/adminAuth.js's header comment. It's deliberately
    // NOT part of the fresh-row INSERT branch: that branch only fires when no admin_account row exists
    // yet at all, so there is no prior session to invalidate and the column's DEFAULT 1 already applies.
    await db.query(
      `INSERT INTO admin_account (id, email, password_hash, updated_at)
       VALUES (1, COALESCE((SELECT email FROM admin_account WHERE id = 1), ''), $1, now())
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         session_epoch = admin_account.session_epoch + 1, updated_at = now()`,
      [passwordHash]
    );
    await db.query('UPDATE admin_password_resets SET used_at = now() WHERE id = $1', [match.id]);

    return { status: 200, jsonBody: { ok: true } };
  } catch (err) {
    context.error('POST /api/staffconsole/reset-password failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminRequestPasswordReset', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/request-password-reset',
  handler: adminRequestPasswordResetHandler,
});

app.http('adminResetPassword', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/reset-password',
  handler: adminResetPasswordHandler,
});

module.exports = { adminRequestPasswordResetHandler, adminResetPasswordHandler, REQUEST_RESET_RATE_LIMIT };
