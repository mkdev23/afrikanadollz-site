// Unit tests for lib/adminAuth.js — the sign/verify session-cookie round trip (now epoch-aware, see
// db/schema.sql's admin_account.session_epoch comment and this file's own header comment for the
// session-revocation mechanism), tampering/expiry/epoch-mismatch rejection, cookie-header parsing,
// and requireAdmin()'s cookie+epoch->auth-result wiring (now async and DB-backed — a small fake `db`
// with a controllable `.query` stands in for a real pg Pool, same "mocked SDK/network, real everything
// else" approach as test/adminApi.test.js).
//
// Run with: node test/adminAuth.test.js
'use strict';

const assert = require('assert');
const {
  SESSION_COOKIE_NAME,
  signSession,
  verifySession,
  parseCookieHeader,
  requireAdmin,
  hashPassword,
  verifyPassword,
  hashResetToken,
  resetTokenMatches,
} = require('../lib/adminAuth');

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

  await test('signSession requires a secret', () => {
    assert.throws(() => signSession('', 1), /secret is required/);
  });

  await test('signSession requires an integer epoch', () => {
    assert.throws(() => signSession('super-secret'), /epoch is required/);
    assert.throws(() => signSession('super-secret', 'one'), /epoch is required/);
    assert.throws(() => signSession('super-secret', 1.5), /epoch is required/);
  });

  await test('a freshly signed token verifies successfully against the same epoch', () => {
    const token = signSession('super-secret', 1);
    assert.strictEqual(verifySession(token, 'super-secret', 1), true);
  });

  await test('verification fails against the wrong secret', () => {
    const token = signSession('super-secret', 1);
    assert.strictEqual(verifySession(token, 'wrong-secret', 1), false);
  });

  await test('verification fails once the epoch has moved on (simulates a password reset)', () => {
    // A token signed while session_epoch was 1 must stop verifying the instant admin_account's
    // session_epoch is bumped to 2 by a password reset — that's the entire revocation mechanism.
    const token = signSession('super-secret', 1);
    assert.strictEqual(verifySession(token, 'super-secret', 1), true); // still epoch 1 -> ok
    assert.strictEqual(verifySession(token, 'super-secret', 2), false); // reset bumped it -> revoked
  });

  await test('verification fails when currentEpoch is missing/not a number', () => {
    const token = signSession('super-secret', 1);
    assert.strictEqual(verifySession(token, 'super-secret', undefined), false);
    assert.strictEqual(verifySession(token, 'super-secret', null), false);
    assert.strictEqual(verifySession(token, 'super-secret', 'one'), false);
  });

  await test('a tampered payload is rejected (signature no longer matches)', () => {
    const token = signSession('super-secret', 1);
    const [payloadB64, sigB64] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ epoch: 1, exp: Date.now() + 999999999 })).toString('base64url');
    assert.notStrictEqual(tamperedPayload, payloadB64);
    const tamperedToken = `${tamperedPayload}.${sigB64}`;
    assert.strictEqual(verifySession(tamperedToken, 'super-secret', 1), false);
  });

  await test('an expired token is rejected', () => {
    const token = signSession('super-secret', 1, -1000); // already expired
    assert.strictEqual(verifySession(token, 'super-secret', 1), false);
  });

  await test('verifySession rejects garbage/malformed input without throwing', () => {
    assert.strictEqual(verifySession(undefined, 'super-secret', 1), false);
    assert.strictEqual(verifySession(null, 'super-secret', 1), false);
    assert.strictEqual(verifySession('not-a-real-token', 'super-secret', 1), false);
    assert.strictEqual(verifySession('a.b.c', 'super-secret', 1), false);
    assert.strictEqual(verifySession('', 'super-secret', 1), false);
    assert.strictEqual(verifySession('abc.def', '', 1), false);
  });

  await test('parseCookieHeader parses a typical multi-cookie header', () => {
    const parsed = parseCookieHeader(`foo=bar; ${SESSION_COOKIE_NAME}=abc123; baz=qux%20quux`);
    assert.strictEqual(parsed.foo, 'bar');
    assert.strictEqual(parsed[SESSION_COOKIE_NAME], 'abc123');
    assert.strictEqual(parsed.baz, 'qux quux');
  });

  await test('parseCookieHeader tolerates missing/empty header', () => {
    assert.deepStrictEqual(parseCookieHeader(undefined), {});
    assert.deepStrictEqual(parseCookieHeader(''), {});
  });

  function fakeRequestWithCookie(cookieHeader) {
    return { headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookieHeader : null) } };
  }

  // A tiny fake pg-Pool-shaped `db` for requireAdmin()'s epoch lookup. `epochResult` may be:
  //   - a number: SELECT returns one row with that session_epoch
  //   - null: SELECT returns zero rows (simulates a missing admin_account row)
  //   - an Error: the query throws (simulates a DB hiccup)
  // `calls` records every query so tests can assert whether the DB was touched at all.
  function fakeDb(epochResult) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (epochResult instanceof Error) throw epochResult;
        if (epochResult === null) return { rows: [] };
        return { rows: [{ session_epoch: epochResult }] };
      },
    };
  }

  await test('requireAdmin returns 500 when ADMIN_SESSION_SECRET is unset, without touching the db', async () => {
    const prev = process.env.ADMIN_SESSION_SECRET;
    delete process.env.ADMIN_SESSION_SECRET;
    try {
      const db = fakeDb(1);
      const result = await requireAdmin(fakeRequestWithCookie(''), db);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 500);
      assert.strictEqual(db.calls.length, 0);
    } finally {
      if (prev !== undefined) process.env.ADMIN_SESSION_SECRET = prev;
    }
  });

  await test('requireAdmin returns 401 with no cookie present, without touching the db', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-secret';
    const db = fakeDb(1);
    const result = await requireAdmin(fakeRequestWithCookie(''), db);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(db.calls.length, 0);
  });

  await test('requireAdmin returns 401 with an invalid cookie', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-secret';
    const db = fakeDb(1);
    const result = await requireAdmin(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=garbage`), db);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });

  await test('requireAdmin returns ok:true with a valid cookie whose epoch matches the db', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-secret';
    const token = signSession('test-secret', 1);
    const db = fakeDb(1);
    const result = await requireAdmin(fakeRequestWithCookie(`other=1; ${SESSION_COOKIE_NAME}=${token}`), db);
    assert.strictEqual(result.ok, true);
  });

  await test('requireAdmin returns 401 once the db\'s epoch has moved past the cookie\'s (a password reset happened)', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-secret';
    const token = signSession('test-secret', 1); // signed while epoch was 1
    const db = fakeDb(2); // admin_account.session_epoch is now 2 -- a reset happened since
    const result = await requireAdmin(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=${token}`), db);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });

  await test('requireAdmin returns 401 when admin_account has no row (epoch lookup returns nothing)', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-secret';
    const token = signSession('test-secret', 1);
    const db = fakeDb(null);
    const result = await requireAdmin(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=${token}`), db);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });

  await test('requireAdmin returns 401 (not a throw) when the epoch lookup query itself fails', async () => {
    process.env.ADMIN_SESSION_SECRET = 'test-secret';
    const token = signSession('test-secret', 1);
    const db = fakeDb(new Error('connection reset'));
    const result = await requireAdmin(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=${token}`), db);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });

  // ---------------- password hashing (admin self-service password reset) ----------------

  await test('hashPassword requires a non-empty password', () => {
    assert.throws(() => hashPassword(''), /password is required/);
    assert.throws(() => hashPassword(undefined), /password is required/);
  });

  await test('hashPassword produces a self-describing scrypt:<salt>:<hash> string, salted per call', () => {
    const a = hashPassword('correct horse battery staple');
    const b = hashPassword('correct horse battery staple');
    assert.ok(/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(a));
    assert.notStrictEqual(a, b); // fresh random salt each call, even for the same password
  });

  await test('verifyPassword round-trips: correct password verifies, wrong password does not', () => {
    const stored = hashPassword('hunter2-but-better');
    assert.strictEqual(verifyPassword('hunter2-but-better', stored), true);
    assert.strictEqual(verifyPassword('wrong-password', stored), false);
  });

  await test('verifyPassword rejects malformed/foreign-format stored hashes without throwing', () => {
    assert.strictEqual(verifyPassword('anything', 'not-a-real-hash'), false);
    assert.strictEqual(verifyPassword('anything', 'bcrypt:abc:def'), false);
    assert.strictEqual(verifyPassword('anything', ''), false);
    assert.strictEqual(verifyPassword('anything', null), false);
    assert.strictEqual(verifyPassword('', hashPassword('x')), false);
  });

  // ---------------- reset-token hashing (admin password reset links) ----------------

  await test('hashResetToken is deterministic SHA-256 hex, and resetTokenMatches round-trips', () => {
    const raw = 'a-very-random-reset-token';
    const hash = hashResetToken(raw);
    assert.ok(/^[0-9a-f]{64}$/.test(hash));
    assert.strictEqual(hashResetToken(raw), hash); // deterministic, unlike password hashing
    assert.strictEqual(resetTokenMatches(raw, hash), true);
    assert.strictEqual(resetTokenMatches('wrong-token', hash), false);
  });

  await test('resetTokenMatches rejects a malformed stored hash without throwing', () => {
    assert.strictEqual(resetTokenMatches('any-token', 'not-hex-at-all!!'), false);
    assert.strictEqual(resetTokenMatches('any-token', ''), false);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
