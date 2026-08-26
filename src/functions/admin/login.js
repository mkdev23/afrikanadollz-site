// POST /api/staffconsole/login — checks the submitted password against the hashed password stored in the
// DB's admin_account row (db/schema.sql) and, on match, issues a signed session cookie via
// lib/adminAuth.js. POST /api/staffconsole/logout clears it. GET /api/staffconsole/session lets admin.html check
// "am I still logged in?" on page load without resubmitting the password (e.g. after a refresh,
// while the cookie is still valid).
//
// The password moved from the static ADMIN_PASSWORD env var into the DB (see db/schema.sql's
// admin_account table + db/seed.js's bootstrap) specifically so the running app can change it
// itself via the new request-password-reset/reset-password endpoints in
// src/functions/admin/passwordReset.js — an env var is set via the Azure control plane and a
// running Function can never rewrite it, so self-service reset was impossible while the password
// lived there. ADMIN_PASSWORD is now only consulted once, by db/seed.js, to bootstrap the initial
// admin_account row.
//
// Follows the same thin-handler / Azure Functions v4 conventions as src/functions/*.js: plain
// `app.http(...)` registrations, `{status, jsonBody}` returns, try/catch around `request.json()`
// with a null fallback. See src/functions/services.js's header comment for the one behavioral
// difference on wrong-method requests (404 via Azure's router instead of an explicit 405 body).
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin, buildSessionCookie, clearSessionCookie, verifyPassword } = require('../../../lib/adminAuth');
const { getClientIp, enforceRateLimit, rateLimitResponse } = require('../../../lib/rateLimit');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

// There is exactly one shared admin password for the whole site (see this file's header comment), so
// unlike the OTP/reset limiters below there's no separate "target identifier" to key on — the target
// is just "the login endpoint," and the caller's IP is the only signal available. crypto.scrypt costs
// ~100ms per guess (lib/adminAuth.js hashPassword/verifyPassword), so an unthrottled attacker could
// try roughly 10 passwords/sec; capping at 6 attempts per 15 minutes per IP cuts that to a rate no
// brute force can meaningfully exploit against a real passphrase, while still comfortably covering a
// legitimate admin who mistypes their password a few times in a row.
const LOGIN_RATE_LIMIT = { bucket: 'admin_login', windowMs: 15 * 60 * 1000, maxAttempts: 6 };

async function adminLoginHandler(request, context) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    context.error('POST /api/staffconsole/login: ADMIN_SESSION_SECRET is not configured.');
    return { status: 500, jsonBody: { error: 'Admin login is not configured.' } };
  }

  const db = getPool();
  const ip = getClientIp(request);
  const blocked = await enforceRateLimit(db, [
    { bucket: LOGIN_RATE_LIMIT.bucket, identifier: `ip:${ip}`, windowMs: LOGIN_RATE_LIMIT.windowMs, maxAttempts: LOGIN_RATE_LIMIT.maxAttempts },
  ]);
  if (blocked) {
    return rateLimitResponse(blocked, 'Too many login attempts. Please try again later.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const password = body && typeof body.password === 'string' ? body.password : '';

  try {
    const { rows } = await db.query('SELECT password_hash, session_epoch FROM admin_account WHERE id = 1');
    if (rows.length === 0) {
      context.error('POST /api/staffconsole/login: no admin_account row exists — run db:seed with ADMIN_EMAIL/ADMIN_PASSWORD set.');
      return { status: 500, jsonBody: { error: 'Admin login is not configured.' } };
    }

    if (!password || !verifyPassword(password, rows[0].password_hash)) {
      return { status: 401, jsonBody: { error: 'Incorrect password.' } };
    }

    return {
      status: 200,
      jsonBody: { ok: true },
      cookies: [buildSessionCookie(secret, rows[0].session_epoch)],
    };
  } catch (err) {
    context.error('POST /api/staffconsole/login failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function adminLogoutHandler() {
  return { status: 200, jsonBody: { ok: true }, cookies: [clearSessionCookie()] };
}

async function adminSessionHandler(request) {
  const auth = await requireAdmin(request, getPool());
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };
  return { status: 200, jsonBody: { ok: true } };
}

app.http('adminLogin', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/login',
  handler: adminLoginHandler,
});

app.http('adminLogout', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'staffconsole/logout',
  handler: adminLogoutHandler,
});

app.http('adminSession', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/session',
  handler: adminSessionHandler,
});

module.exports = { adminLoginHandler, adminLogoutHandler, adminSessionHandler, LOGIN_RATE_LIMIT };
