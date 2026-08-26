// Mocked-DB unit tests for the /api/staffconsole/* handlers (src/functions/admin/*.js). No live Postgres
// involved: the `pg` package is swapped for an in-memory fake via require-cache substitution, the
// same "mocked SDK/network, real everything else" approach test/styleSuggest.test.js uses for
// lib/openai.js. `@azure/functions` itself is NOT mocked (app.http(...) registration needs the real
// package, already a project dependency) — only pg's Pool is faked, so this exercises the actual
// validation/SQL-shaping/response-status logic in each handler, just not real Postgres semantics.
//
// Run with: node test/adminApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const ADMIN_DIR = path.join(__dirname, '..', 'src', 'functions', 'admin');
const LOGIN_PATH = path.join(ADMIN_DIR, 'login.js');
const PASSWORD_RESET_PATH = path.join(ADMIN_DIR, 'passwordReset.js');
const APPOINTMENTS_PATH = path.join(ADMIN_DIR, 'appointments.js');
const BLOCKED_SLOTS_PATH = path.join(ADMIN_DIR, 'blockedSlots.js');
const AVAILABILITY_RULES_PATH = path.join(ADMIN_DIR, 'availabilityRules.js');
const SETTINGS_PATH = path.join(ADMIN_DIR, 'settings.js');
const ADMIN_AUTH_PATH = path.join(__dirname, '..', 'lib', 'adminAuth.js');
const EMAIL_PATH = path.join(__dirname, '..', 'lib', 'email.js');

const { signSession, SESSION_COOKIE_NAME, hashPassword, hashResetToken, verifyPassword } = require(ADMIN_AUTH_PATH);
const { zonedWallTimeToUtc } = require('../lib/availability');

// A minimal fake `pg.Pool`: `query` is provided per-test and used both for direct pool.query() calls
// and (via the same impl) for the client returned by pool.connect(), since none of these handlers'
// tests need real transactional isolation -- just to observe what SQL/params got sent and control
// what comes back.
//
// Two kinds of query are now issued by nearly EVERY handler in this file that never used to touch the
// DB more than once per call, and neither is something most individual tests care about, so both are
// handled transparently here rather than in every test body:
//   - requireAdmin()'s epoch lookup (`SELECT session_epoch FROM admin_account WHERE id = 1`) --
//     answered from `state.epoch` (default 1, matching authedCookie()'s default signing epoch below).
//     A test that specifically wants to exercise epoch mismatch/revocation can set `state.epoch`
//     after loading, or pass `epoch: null` to simulate a missing admin_account row.
//   - lib/rateLimit.js's rate_limit_events COUNT/INSERT (used by admin/login.js and
//     admin/passwordReset.js's request-password-reset) -- backed by a real (if tiny) in-memory sliding
//     window per FakePool instance, exactly like test/rateLimit.test.js's fake db, so a test that calls
//     a rate-limited handler more times than its threshold allows genuinely observes a 429, while a
//     test that just calls it once or twice (i.e. nearly all of the existing tests below) never gets
//     anywhere near tripping it.
// Neither kind of query is pushed into `calls` or routed through the test's own queryImpl -- they're
// infrastructure, not the business-logic SQL these tests exist to assert on.
function makeFakePool(queryImpl, { epoch = 1 } = {}) {
  const calls = [];
  const rateLimitEvents = [];
  const state = { epoch };
  const wrappedQuery = async (sql, params) => {
    if (/^SELECT session_epoch FROM admin_account WHERE id = 1$/.test(sql)) {
      return state.epoch === null ? { rows: [] } : { rows: [{ session_epoch: state.epoch }] };
    }
    if (/^SELECT COUNT\(\*\)::int AS count FROM rate_limit_events/.test(sql)) {
      const [bucket, identifier, windowMs] = params;
      const cutoff = Date.now() - windowMs;
      const count = rateLimitEvents.filter((e) => e.bucket === bucket && e.identifier === identifier && e.createdAt > cutoff).length;
      return { rows: [{ count }] };
    }
    if (/^INSERT INTO rate_limit_events/.test(sql)) {
      const [bucket, identifier] = params;
      rateLimitEvents.push({ bucket, identifier, createdAt: Date.now() });
      return { rows: [] };
    }
    calls.push({ sql, params });
    return queryImpl(sql, params, calls.length - 1);
  };
  class FakePool {
    constructor() {}
    async query(sql, params) {
      return wrappedQuery(sql, params);
    }
    async connect() {
      return {
        query: wrappedQuery,
        release: () => {},
      };
    }
  }
  return { FakePool, calls, rateLimitEvents, state };
}

function loadHandlerWithMockedPg(modulePath, queryImpl, opts) {
  const { FakePool, calls, rateLimitEvents, state } = makeFakePool(queryImpl, opts);
  delete require.cache[PG_PATH];
  delete require.cache[modulePath];
  const fakePgModule = new Module(PG_PATH);
  fakePgModule.exports = { Pool: FakePool };
  fakePgModule.loaded = true;
  require.cache[PG_PATH] = fakePgModule;
  const mod = require(modulePath);
  delete require.cache[PG_PATH];
  delete require.cache[modulePath];
  return { mod, calls, rateLimitEvents, state };
}

// Same shape as loadHandlerWithMockedPg, but also swaps lib/email.js for a spy so
// passwordReset.js's sendAdminPasswordResetEmail call can be observed without any real ACS call.
function loadPasswordResetHandlerWithMocks(queryImpl, { sendAdminPasswordResetEmail } = {}) {
  const { FakePool, calls, rateLimitEvents, state } = makeFakePool(queryImpl);
  delete require.cache[PG_PATH];
  delete require.cache[EMAIL_PATH];
  delete require.cache[PASSWORD_RESET_PATH];

  const fakePgModule = new Module(PG_PATH);
  fakePgModule.exports = { Pool: FakePool };
  fakePgModule.loaded = true;
  require.cache[PG_PATH] = fakePgModule;

  const emailCalls = [];
  const fakeEmailModule = new Module(EMAIL_PATH);
  fakeEmailModule.exports = {
    sendAdminPasswordResetEmail: async (toEmail, resetUrl) => {
      emailCalls.push({ toEmail, resetUrl });
      if (sendAdminPasswordResetEmail) return sendAdminPasswordResetEmail(toEmail, resetUrl);
    },
  };
  fakeEmailModule.loaded = true;
  require.cache[EMAIL_PATH] = fakeEmailModule;

  const mod = require(PASSWORD_RESET_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[EMAIL_PATH];
  delete require.cache[PASSWORD_RESET_PATH];
  return { mod, calls, emailCalls, rateLimitEvents, state };
}

function fakeRequest({ body, query, params, cookie, ip } = {}) {
  const q = new Map(Object.entries(query || {}));
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    query: { get: (k) => (q.has(k) ? q.get(k) : null) },
    params: params || {},
    headers: {
      get: (name) => {
        const n = name.toLowerCase();
        if (n === 'cookie') return cookie || '';
        if (n === 'x-forwarded-for') return ip || null;
        return null;
      },
    },
  };
}
function fakeContext() {
  const errors = [];
  return { error: (...args) => errors.push(args), warn: () => {}, errors };
}

// Default epoch of 1 matches makeFakePool()'s default `state.epoch` above, so a plain authedCookie()
// verifies against any freshly-loaded handler's mocked db without either side needing to say so.
function authedCookie(secret, epoch = 1) {
  return `${SESSION_COOKIE_NAME}=${signSession(secret, epoch)}`;
}

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  process.env.ADMIN_SESSION_SECRET = 'test-secret';
  process.env.ADMIN_PASSWORD = 'hunter2'; // only consulted by db/seed.js now, not login.js — kept
  // set here in case any other test in this file/process still reads it incidentally.
  const COOKIE = authedCookie('test-secret');

  // ---------------- login/logout/session ----------------
  // Login moved from comparing against the ADMIN_PASSWORD env var to checking a hashed password
  // stored in the admin_account table (db/schema.sql), so the app itself can rewrite it via the new
  // request-password-reset/reset-password endpoints below — see src/functions/admin/login.js's
  // header comment for why that env var could never be self-service-updatable.

  const STORED_ADMIN_HASH = hashPassword('hunter2');

  await test('login: 401 on wrong password', async () => {
    const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({
      rows: [{ password_hash: STORED_ADMIN_HASH }],
    }));
    const res = await mod.adminLoginHandler(fakeRequest({ body: { password: 'wrong' } }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('login: 200 + session cookie on correct password, signed with the account\'s current epoch', async () => {
    const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({
      rows: [{ password_hash: STORED_ADMIN_HASH, session_epoch: 7 }],
    }));
    const res = await mod.adminLoginHandler(fakeRequest({ body: { password: 'hunter2' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.cookies) && res.cookies.length === 1);
    assert.strictEqual(res.cookies[0].name, SESSION_COOKIE_NAME);
    assert.strictEqual(res.cookies[0].httpOnly, true);
    assert.strictEqual(res.cookies[0].sameSite, 'Strict');
    // The signed cookie embeds whatever epoch the db reported (7 here), not a hardcoded 1 -- this is
    // what lets a later password reset (which bumps the stored epoch) invalidate it.
    const { verifySession } = require('../lib/adminAuth');
    assert.strictEqual(verifySession(res.cookies[0].value, 'test-secret', 7), true);
    assert.strictEqual(verifySession(res.cookies[0].value, 'test-secret', 8), false);
  });

  await test('login: rate-limited after LOGIN_RATE_LIMIT.maxAttempts attempts from the same IP, regardless of password correctness', async () => {
    const { LOGIN_RATE_LIMIT } = require(LOGIN_PATH);
    const { mod, rateLimitEvents } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({
      rows: [{ password_hash: STORED_ADMIN_HASH, session_epoch: 1 }],
    }));
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      const res = await mod.adminLoginHandler(fakeRequest({ body: { password: 'wrong' }, ip: '198.51.100.9' }), fakeContext());
      assert.strictEqual(res.status, 401, `attempt ${i + 1} should still just be a wrong-password 401`);
    }
    const blockedRes = await mod.adminLoginHandler(fakeRequest({ body: { password: 'hunter2' }, ip: '198.51.100.9' }), fakeContext());
    assert.strictEqual(blockedRes.status, 429, 'the correct password should not help once the IP is rate-limited');
    assert.ok(typeof blockedRes.jsonBody.retryAfterSeconds === 'number');
    assert.strictEqual(blockedRes.headers['Retry-After'], String(blockedRes.jsonBody.retryAfterSeconds));
    assert.ok(rateLimitEvents.some((e) => e.bucket === LOGIN_RATE_LIMIT.bucket && e.identifier === 'ip:198.51.100.9'));
  });

  await test('login: a different IP is not affected by another IP\'s rate limit', async () => {
    const { LOGIN_RATE_LIMIT } = require(LOGIN_PATH);
    const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({
      rows: [{ password_hash: STORED_ADMIN_HASH, session_epoch: 1 }],
    }));
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      await mod.adminLoginHandler(fakeRequest({ body: { password: 'wrong' }, ip: '198.51.100.10' }), fakeContext());
    }
    const otherIpRes = await mod.adminLoginHandler(fakeRequest({ body: { password: 'hunter2' }, ip: '198.51.100.11' }), fakeContext());
    assert.strictEqual(otherIpRes.status, 200);
  });

  await test('login: 500 when ADMIN_SESSION_SECRET unset', async () => {
    const prev = process.env.ADMIN_SESSION_SECRET;
    delete process.env.ADMIN_SESSION_SECRET;
    try {
      const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({
        rows: [{ password_hash: STORED_ADMIN_HASH }],
      }));
      const res = await mod.adminLoginHandler(fakeRequest({ body: { password: 'hunter2' } }), fakeContext());
      assert.strictEqual(res.status, 500);
    } finally {
      process.env.ADMIN_SESSION_SECRET = prev;
    }
  });

  await test('login: 500 when no admin_account row exists yet (bootstrap seed never ran)', async () => {
    const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({ rows: [] }));
    const res = await mod.adminLoginHandler(fakeRequest({ body: { password: 'hunter2' } }), fakeContext());
    assert.strictEqual(res.status, 500);
  });

  await test('logout: clears the cookie (maxAge 0)', async () => {
    const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({ rows: [] }));
    const res = await mod.adminLogoutHandler();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.cookies[0].maxAge, 0);
  });

  await test('session: 401 with no cookie, 200 with a valid one', async () => {
    const { mod } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({ rows: [] }));
    const unauth = await mod.adminSessionHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(unauth.status, 401);
    const auth = await mod.adminSessionHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
    assert.strictEqual(auth.status, 200);
  });

  await test('session: a cookie signed under epoch 1 is rejected once the db reports epoch 2 (password was reset)', async () => {
    const { mod, state } = loadHandlerWithMockedPg(LOGIN_PATH, async () => ({ rows: [] }));
    const cookieEpoch1 = authedCookie('test-secret', 1);
    const stillGood = await mod.adminSessionHandler(fakeRequest({ cookie: cookieEpoch1 }), fakeContext());
    assert.strictEqual(stillGood.status, 200);

    state.epoch = 2; // simulates admin/passwordReset.js's reset-password handler having bumped it
    const nowRevoked = await mod.adminSessionHandler(fakeRequest({ cookie: cookieEpoch1 }), fakeContext());
    assert.strictEqual(nowRevoked.status, 401);

    // A freshly-signed epoch-2 cookie (as a real login after the reset would produce) still works.
    const cookieEpoch2 = authedCookie('test-secret', 2);
    const freshLogin = await mod.adminSessionHandler(fakeRequest({ cookie: cookieEpoch2 }), fakeContext());
    assert.strictEqual(freshLogin.status, 200);
  });

  // ---------------- admin password reset (request-password-reset / reset-password) ----------------

  await test('request-password-reset: always 200 generic response, even for an unregistered email', async () => {
    const { mod, calls, emailCalls } = loadPasswordResetHandlerWithMocks(async (sql) => {
      if (/SELECT email FROM admin_account/.test(sql)) return { rows: [{ email: 'diaka@afrikanadollz.com' }] };
      return { rows: [] };
    });
    const res = await mod.adminRequestPasswordResetHandler(
      fakeRequest({ body: { email: 'not-the-admin@example.com' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.ok, true);
    assert.strictEqual(emailCalls.length, 0); // no match -> no email, but same response shape
    assert.ok(!calls.some((c) => /INSERT INTO admin_password_resets/.test(c.sql)));
  });

  await test('request-password-reset: matching email — stores a hashed token and emails a reset link; same generic response', async () => {
    const { mod, calls, emailCalls } = loadPasswordResetHandlerWithMocks(async (sql) => {
      if (/SELECT email FROM admin_account/.test(sql)) return { rows: [{ email: 'Diaka@AfrikanaDollz.com' }] };
      if (/INSERT INTO admin_password_resets/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.adminRequestPasswordResetHandler(
      fakeRequest({ body: { email: 'diaka@afrikanadollz.com' } }), // case-insensitive match
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.ok, true);
    assert.strictEqual(emailCalls.length, 1);
    assert.strictEqual(emailCalls[0].toEmail, 'Diaka@AfrikanaDollz.com');
    assert.ok(/\/admin\.html\?resetToken=/.test(emailCalls[0].resetUrl));

    const insert = calls.find((c) => /INSERT INTO admin_password_resets/.test(c.sql));
    assert.ok(insert);
    const sentToken = decodeURIComponent(emailCalls[0].resetUrl.split('resetToken=')[1]);
    // the stored hash must NOT equal the raw token embedded in the emailed link
    assert.notStrictEqual(insert.params[0], sentToken);
    assert.strictEqual(insert.params[0], hashResetToken(sentToken));
  });

  await test('request-password-reset: still returns the generic response even if the email send itself fails', async () => {
    const { mod } = loadPasswordResetHandlerWithMocks(
      async (sql) => {
        if (/SELECT email FROM admin_account/.test(sql)) return { rows: [{ email: 'diaka@afrikanadollz.com' }] };
        return { rows: [] };
      },
      { sendAdminPasswordResetEmail: async () => { throw new Error('ACS not configured'); } }
    );
    const res = await mod.adminRequestPasswordResetHandler(
      fakeRequest({ body: { email: 'diaka@afrikanadollz.com' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.ok, true);
  });

  await test('reset-password: 400 on missing token or too-short newPassword', async () => {
    const { mod } = loadPasswordResetHandlerWithMocks(async () => ({ rows: [] }));
    const noToken = await mod.adminResetPasswordHandler(
      fakeRequest({ body: { token: '', newPassword: 'longenough123' } }),
      fakeContext()
    );
    assert.strictEqual(noToken.status, 400);
    const shortPw = await mod.adminResetPasswordHandler(
      fakeRequest({ body: { token: 'sometoken', newPassword: 'short' } }),
      fakeContext()
    );
    assert.strictEqual(shortPw.status, 400);
  });

  await test('reset-password: 401 when no matching unused/unexpired reset row exists', async () => {
    const { mod } = loadPasswordResetHandlerWithMocks(async (sql) => {
      if (/SELECT id, token_hash FROM admin_password_resets/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.adminResetPasswordHandler(
      fakeRequest({ body: { token: 'nope', newPassword: 'longenough123' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('reset-password: 200 on a valid token — hashes+stores the new password, marks the token used', async () => {
    const rawToken = 'a-very-random-admin-reset-token';
    const tokenHash = hashResetToken(rawToken);
    const { mod, calls } = loadPasswordResetHandlerWithMocks(async (sql) => {
      if (/SELECT id, token_hash FROM admin_password_resets/.test(sql)) {
        return { rows: [{ id: 42, token_hash: tokenHash }] };
      }
      if (/INSERT INTO admin_account/.test(sql)) return { rows: [] };
      if (/UPDATE admin_password_resets SET used_at/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.adminResetPasswordHandler(
      fakeRequest({ body: { token: rawToken, newPassword: 'a-brand-new-password' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.ok, true);

    const upsert = calls.find((c) => /INSERT INTO admin_account/.test(c.sql));
    assert.ok(upsert);
    // the stored hash must actually verify against the new password (round-trips through hashPassword)
    assert.strictEqual(verifyPassword('a-brand-new-password', upsert.params[0]), true);
    // Session revocation: the conflict-branch upsert must bump session_epoch so every previously
    // issued admin session cookie stops verifying (db/schema.sql's admin_account.session_epoch
    // comment) -- this can't be asserted via a bound param since it's an inline SQL expression, so
    // check the SQL text itself.
    assert.ok(/session_epoch = admin_account\.session_epoch \+ 1/.test(upsert.sql));

    const usedUpdate = calls.find((c) => /UPDATE admin_password_resets SET used_at/.test(c.sql));
    assert.deepStrictEqual(usedUpdate.params, [42]);
  });

  await test('request-password-reset: rate-limited per submitted email (target), independent of IP', async () => {
    const { REQUEST_RESET_RATE_LIMIT } = require(PASSWORD_RESET_PATH);
    const { mod, rateLimitEvents } = loadPasswordResetHandlerWithMocks(async (sql) => {
      if (/SELECT email FROM admin_account/.test(sql)) return { rows: [{ email: 'diaka@afrikanadollz.com' }] };
      return { rows: [] };
    });
    for (let i = 0; i < REQUEST_RESET_RATE_LIMIT.maxAttemptsPerTarget; i++) {
      const res = await mod.adminRequestPasswordResetHandler(
        fakeRequest({ body: { email: 'diaka@afrikanadollz.com' }, ip: `203.0.113.${i}` }), // different IP each time
        fakeContext()
      );
      assert.strictEqual(res.status, 200, `attempt ${i + 1} for this target should still succeed`);
    }
    const blocked = await mod.adminRequestPasswordResetHandler(
      fakeRequest({ body: { email: 'diaka@afrikanadollz.com' }, ip: '203.0.113.99' }),
      fakeContext()
    );
    assert.strictEqual(blocked.status, 429, 'the target (email) cap should trip even though every attempt used a different IP');
    assert.ok(rateLimitEvents.some((e) => e.bucket === REQUEST_RESET_RATE_LIMIT.bucket && e.identifier === 'target:diaka@afrikanadollz.com'));
  });

  await test('request-password-reset: rate-limited per IP too, capping a flood of different bogus emails from one source', async () => {
    const { REQUEST_RESET_RATE_LIMIT } = require(PASSWORD_RESET_PATH);
    const { mod } = loadPasswordResetHandlerWithMocks(async (sql) => {
      if (/SELECT email FROM admin_account/.test(sql)) return { rows: [{ email: 'diaka@afrikanadollz.com' }] };
      return { rows: [] };
    });
    for (let i = 0; i < REQUEST_RESET_RATE_LIMIT.maxAttemptsPerIp; i++) {
      const res = await mod.adminRequestPasswordResetHandler(
        fakeRequest({ body: { email: `guess-${i}@example.com` }, ip: '203.0.113.50' }), // different target each time
        fakeContext()
      );
      assert.strictEqual(res.status, 200);
    }
    const blocked = await mod.adminRequestPasswordResetHandler(
      fakeRequest({ body: { email: 'yet-another-guess@example.com' }, ip: '203.0.113.50' }),
      fakeContext()
    );
    assert.strictEqual(blocked.status, 429);
  });

  // ---------------- appointments ----------------

  await test('appointments list: 401 without auth', async () => {
    const { mod } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: [] }));
    const res = await mod.adminAppointmentsListHandler(
      fakeRequest({ query: { from: '2026-08-01', to: '2026-08-31' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('appointments list: 400 on missing/invalid date range', async () => {
    const { mod } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: [] }));
    const res1 = await mod.adminAppointmentsListHandler(fakeRequest({ cookie: COOKIE, query: {} }), fakeContext());
    assert.strictEqual(res1.status, 400);
    const res2 = await mod.adminAppointmentsListHandler(
      fakeRequest({ cookie: COOKIE, query: { from: '2026-08-31', to: '2026-08-01' } }),
      fakeContext()
    );
    assert.strictEqual(res2.status, 400);
  });

  await test('appointments list: 200, queries with the requested range and returns rows', async () => {
    const fakeRows = [{ id: 1, service_name: 'Braids', start_at: '2026-08-05T14:00:00.000Z' }];
    const { mod, calls } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: fakeRows }));
    const res = await mod.adminAppointmentsListHandler(
      fakeRequest({ cookie: COOKIE, query: { from: '2026-08-01', to: '2026-08-31' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.appointments, fakeRows);
    assert.deepStrictEqual(calls[0].params, ['2026-08-01', '2026-08-31']);
    assert.ok(/JOIN services/.test(calls[0].sql));
  });

  await test('appointment status: 400 on bad id and bad status', async () => {
    const { mod } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: [] }));
    const badId = await mod.adminAppointmentStatusHandler(
      fakeRequest({ cookie: COOKIE, params: { id: 'abc' }, body: { status: 'completed' } }),
      fakeContext()
    );
    assert.strictEqual(badId.status, 400);
    const badStatus = await mod.adminAppointmentStatusHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { status: 'made_up' } }),
      fakeContext()
    );
    assert.strictEqual(badStatus.status, 400);
  });

  await test('appointment status: 404 when no row matched', async () => {
    const { mod } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({ rows: [] }));
    const res = await mod.adminAppointmentStatusHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' }, body: { status: 'no_show' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('appointment status: 200 updates and returns the row', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(APPOINTMENTS_PATH, async () => ({
      rows: [{ id: 7, status: 'no_show' }],
    }));
    const res = await mod.adminAppointmentStatusHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '7' }, body: { status: 'no_show' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.appointment.status, 'no_show');
    assert.deepStrictEqual(calls[0].params, ['no_show', '7']);
  });

  // ---------------- blocked slots ----------------

  await test('blocked slots create: validation errors (missing date, bad time order)', async () => {
    const { mod } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async () => ({ rows: [] }));
    const missingDate = await mod.adminBlockedSlotsCreateHandler(
      fakeRequest({ cookie: COOKIE, body: { allDay: true } }),
      fakeContext()
    );
    assert.strictEqual(missingDate.status, 400);
    const badOrder = await mod.adminBlockedSlotsCreateHandler(
      fakeRequest({
        cookie: COOKIE,
        body: { date: '2026-08-20', allDay: false, startTime: '15:00', endTime: '14:00' },
      }),
      fakeContext()
    );
    assert.strictEqual(badOrder.status, 400);
    assert.ok(/before endTime/.test(JSON.stringify(badOrder.jsonBody.details)));
  });

  await test('blocked slots create: allDay=true resolves to local-midnight-to-local-midnight UTC instants', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async (sql, params) => ({
      rows: [{ id: 1, start_at: params[0], end_at: params[1], reason: params[2] }],
    }));
    const res = await mod.adminBlockedSlotsCreateHandler(
      fakeRequest({ cookie: COOKIE, body: { date: '2026-08-20', allDay: true, reason: 'Day off' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201);
    const expectedStart = zonedWallTimeToUtc(2026, 8, 20, 0, 0, 'America/New_York').toISOString();
    const expectedEnd = zonedWallTimeToUtc(2026, 8, 21, 0, 0, 'America/New_York').toISOString();
    assert.strictEqual(calls[0].params[0], expectedStart);
    assert.strictEqual(calls[0].params[1], expectedEnd);
    assert.strictEqual(calls[0].params[2], 'Day off');
  });

  await test('blocked slots create: partial-day block uses startTime/endTime on the given date', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async (sql, params) => ({
      rows: [{ id: 2, start_at: params[0], end_at: params[1], reason: params[2] }],
    }));
    const res = await mod.adminBlockedSlotsCreateHandler(
      fakeRequest({
        cookie: COOKIE,
        body: { date: '2026-01-15', allDay: false, startTime: '09:00', endTime: '11:30' },
      }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201);
    const expectedStart = zonedWallTimeToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString();
    const expectedEnd = zonedWallTimeToUtc(2026, 1, 15, 11, 30, 'America/New_York').toISOString();
    assert.strictEqual(calls[0].params[0], expectedStart);
    assert.strictEqual(calls[0].params[1], expectedEnd);
  });

  await test('blocked slots delete: 400 on bad id, 404 when nothing deleted, 204 on success', async () => {
    const { mod: modBadId } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async () => ({ rowCount: 0 }));
    const badId = await modBadId.adminBlockedSlotsDeleteHandler(
      fakeRequest({ cookie: COOKIE, params: { id: 'nope' } }),
      fakeContext()
    );
    assert.strictEqual(badId.status, 400);

    const { mod: modNotFound } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async () => ({ rowCount: 0 }));
    const notFound = await modNotFound.adminBlockedSlotsDeleteHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '42' } }),
      fakeContext()
    );
    assert.strictEqual(notFound.status, 404);

    const { mod: modOk } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async () => ({ rowCount: 1 }));
    const ok = await modOk.adminBlockedSlotsDeleteHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '42' } }),
      fakeContext()
    );
    assert.strictEqual(ok.status, 204);
  });

  await test('blocked slots list: 200 with rows', async () => {
    const rows = [{ id: 1, start_at: 'x', end_at: 'y', reason: null }];
    const { mod } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async () => ({ rows }));
    const res = await mod.adminBlockedSlotsListHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.blockedSlots, rows);
  });

  // ---------------- availability rules ----------------

  await test('availability rules GET: 200 with rows', async () => {
    const rows = [{ id: 1, weekday: 2, start_time: '10:00:00', end_time: '18:00:00' }];
    const { mod } = loadHandlerWithMockedPg(AVAILABILITY_RULES_PATH, async () => ({ rows }));
    const res = await mod.adminAvailabilityRulesGetHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.rules, rows);
  });

  await test('availability rules PUT: validates weekday range, time format, duplicate weekdays, ordering', async () => {
    const { mod } = loadHandlerWithMockedPg(AVAILABILITY_RULES_PATH, async () => ({ rows: [] }));
    const notArray = await mod.adminAvailabilityRulesPutHandler(
      fakeRequest({ cookie: COOKIE, body: { rules: 'nope' } }),
      fakeContext()
    );
    assert.strictEqual(notArray.status, 400);

    const badWeekday = await mod.adminAvailabilityRulesPutHandler(
      fakeRequest({ cookie: COOKIE, body: { rules: [{ weekday: 9, start_time: '10:00', end_time: '18:00' }] } }),
      fakeContext()
    );
    assert.strictEqual(badWeekday.status, 400);

    const badOrder = await mod.adminAvailabilityRulesPutHandler(
      fakeRequest({ cookie: COOKIE, body: { rules: [{ weekday: 2, start_time: '18:00', end_time: '10:00' }] } }),
      fakeContext()
    );
    assert.strictEqual(badOrder.status, 400);

    const dup = await mod.adminAvailabilityRulesPutHandler(
      fakeRequest({
        cookie: COOKIE,
        body: {
          rules: [
            { weekday: 2, start_time: '10:00', end_time: '18:00' },
            { weekday: 2, start_time: '11:00', end_time: '19:00' },
          ],
        },
      }),
      fakeContext()
    );
    assert.strictEqual(dup.status, 400);
  });

  await test('availability rules PUT: valid payload runs DELETE+INSERT-per-rule inside BEGIN/COMMIT, then re-reads', async () => {
    const rules = [
      { weekday: 2, start_time: '10:00', end_time: '18:00' },
      { weekday: 3, start_time: '10:00', end_time: '18:00' },
    ];
    let readCalls = 0;
    const { mod, calls } = loadHandlerWithMockedPg(AVAILABILITY_RULES_PATH, async (sql) => {
      if (/^SELECT/.test(sql)) {
        readCalls++;
        return { rows: rules.map((r, i) => ({ id: i + 1, ...r })) };
      }
      return { rows: [] };
    });
    const res = await mod.adminAvailabilityRulesPutHandler(fakeRequest({ cookie: COOKIE, body: { rules } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.rules.length, 2);
    const sqls = calls.map((c) => c.sql);
    assert.ok(sqls.some((s) => /^BEGIN/.test(s)));
    assert.ok(sqls.some((s) => /^DELETE FROM availability_rules/.test(s)));
    assert.strictEqual(sqls.filter((s) => /^INSERT INTO availability_rules/.test(s)).length, 2);
    assert.ok(sqls.some((s) => /^COMMIT/.test(s)));
    assert.strictEqual(readCalls, 1); // only the post-commit re-read, GET wasn't called in this test
  });

  // ---------------- settings ----------------

  await test('settings GET: maps key/value rows into an object', async () => {
    const rows = [
      { key: 'shopify', value: { storeDomain: '', connected: false }, updated_at: '2026-01-01T00:00:00Z' },
    ];
    const { mod } = loadHandlerWithMockedPg(SETTINGS_PATH, async () => ({ rows }));
    const res = await mod.adminSettingsGetHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.settings, { shopify: { storeDomain: '', connected: false } });
  });

  await test('settings PUT: validates key format and object-shaped value', async () => {
    const { mod } = loadHandlerWithMockedPg(SETTINGS_PATH, async () => ({ rows: [] }));
    const badKey = await mod.adminSettingsPutHandler(
      fakeRequest({ cookie: COOKIE, body: { key: 'bad key!', value: {} } }),
      fakeContext()
    );
    assert.strictEqual(badKey.status, 400);
    const badValue = await mod.adminSettingsPutHandler(
      fakeRequest({ cookie: COOKIE, body: { key: 'shopify', value: 'not-an-object' } }),
      fakeContext()
    );
    assert.strictEqual(badValue.status, 400);
  });

  await test('settings PUT: 200 upserts and returns the saved row', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(SETTINGS_PATH, async (sql, params) => ({
      rows: [{ key: params[0], value: JSON.parse(params[1]), updated_at: '2026-01-01T00:00:00Z' }],
    }));
    const res = await mod.adminSettingsPutHandler(
      fakeRequest({ cookie: COOKIE, body: { key: 'shopify', value: { storeDomain: 'diaka.myshopify.com' } } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.setting.key, 'shopify');
    assert.deepStrictEqual(res.jsonBody.setting.value, { storeDomain: 'diaka.myshopify.com' });
    assert.ok(/ON CONFLICT/.test(calls[0].sql));
  });

  await test('settings/appointments/blockedSlots/availabilityRules handlers all reject unauthenticated requests', async () => {
    const { mod: settingsMod } = loadHandlerWithMockedPg(SETTINGS_PATH, async () => ({ rows: [] }));
    const s = await settingsMod.adminSettingsGetHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(s.status, 401);

    const { mod: blockedMod } = loadHandlerWithMockedPg(BLOCKED_SLOTS_PATH, async () => ({ rows: [] }));
    const b = await blockedMod.adminBlockedSlotsListHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(b.status, 401);

    const { mod: rulesMod } = loadHandlerWithMockedPg(AVAILABILITY_RULES_PATH, async () => ({ rows: [] }));
    const r = await rulesMod.adminAvailabilityRulesGetHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(r.status, 401);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
