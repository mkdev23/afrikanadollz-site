// Unit tests for lib/rateLimit.js -- getClientIp()'s x-forwarded-for parsing, and
// enforceRateLimit()'s count/threshold/window logic against a small in-memory fake `db` that actually
// implements the same sliding-window semantics as the real `rate_limit_events` SQL (COUNT rows newer
// than now() - windowMs), just in JS, with a controllable clock -- no real Postgres, and no real
// sleeps: window expiry is tested by advancing the fake clock, not by waiting.
//
// Run with: node test/rateLimit.test.js
'use strict';

const assert = require('assert');
const { getClientIp, enforceRateLimit, rateLimitResponse } = require('../lib/rateLimit');

/**
 * A tiny fake pg-Pool-shaped `db` that actually models rate_limit_events: COUNT(*) filters rows by
 * (bucket, identifier, created_at > now - windowMs) and INSERT appends one. `now` is a function so
 * tests can move the clock forward without a real sleep.
 */
function makeFakeDb(now) {
  const events = []; // {bucket, identifier, createdAt}
  return {
    events,
    query: async (sql, params) => {
      if (/^SELECT COUNT/.test(sql)) {
        const [bucket, identifier, windowMs] = params;
        const cutoff = now() - windowMs;
        const count = events.filter((e) => e.bucket === bucket && e.identifier === identifier && e.createdAt > cutoff).length;
        return { rows: [{ count }] };
      }
      if (/^INSERT INTO rate_limit_events/.test(sql)) {
        const [bucket, identifier] = params;
        events.push({ bucket, identifier, createdAt: now() });
        return { rows: [] };
      }
      throw new Error(`fakeDb: unexpected query: ${sql}`);
    },
  };
}

function fakeRequestWithForwardedFor(header) {
  return { headers: { get: (name) => (name.toLowerCase() === 'x-forwarded-for' ? header : null) } };
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

  // ================================================================
  // getClientIp
  // ================================================================

  await test('getClientIp takes the first hop of a multi-proxy x-forwarded-for chain', () => {
    const ip = getClientIp(fakeRequestWithForwardedFor('203.0.113.7, 10.0.0.1, 10.0.0.2'));
    assert.strictEqual(ip, '203.0.113.7');
  });

  await test('getClientIp strips a trailing :port from a plain IPv4 entry', () => {
    const ip = getClientIp(fakeRequestWithForwardedFor('203.0.113.7:54321'));
    assert.strictEqual(ip, '203.0.113.7');
  });

  await test('getClientIp leaves an IPv6 entry untouched (does not mangle its colons)', () => {
    const ip = getClientIp(fakeRequestWithForwardedFor('2001:db8::1'));
    assert.strictEqual(ip, '2001:db8::1');
  });

  await test('getClientIp falls back to "unknown" for a missing/empty header, without throwing', () => {
    assert.strictEqual(getClientIp(fakeRequestWithForwardedFor(null)), 'unknown');
    assert.strictEqual(getClientIp(fakeRequestWithForwardedFor('')), 'unknown');
    assert.strictEqual(getClientIp({ headers: { get: () => { throw new Error('boom'); } } }), 'unknown');
    assert.strictEqual(getClientIp({}), 'unknown'); // no .headers at all
  });

  // ================================================================
  // enforceRateLimit
  // ================================================================

  await test('staying under the threshold never blocks', async () => {
    let now = 1_000_000;
    const db = makeFakeDb(() => now);
    const check = { bucket: 'admin_login', identifier: 'ip:1.2.3.4', windowMs: 60_000, maxAttempts: 5 };
    for (let i = 0; i < 4; i++) {
      const blocked = await enforceRateLimit(db, [check]);
      assert.strictEqual(blocked, null, `attempt ${i + 1} should not be blocked`);
      now += 1000;
    }
  });

  await test('exceeding the threshold returns a blocked result on the (maxAttempts+1)th attempt', async () => {
    let now = 2_000_000;
    const db = makeFakeDb(() => now);
    const check = { bucket: 'admin_login', identifier: 'ip:9.9.9.9', windowMs: 60_000, maxAttempts: 3 };
    // Attempts 1-3 are allowed (0, 1, 2 prior events counted respectively -- all < 3).
    for (let i = 0; i < 3; i++) {
      const blocked = await enforceRateLimit(db, [check]);
      assert.strictEqual(blocked, null);
      now += 100;
    }
    // The 4th attempt now sees 3 prior events >= maxAttempts(3) -> blocked.
    const blocked = await enforceRateLimit(db, [check]);
    assert.ok(blocked);
    assert.strictEqual(blocked.bucket, 'admin_login');
    assert.strictEqual(blocked.identifier, 'ip:9.9.9.9');
    assert.strictEqual(blocked.retryAfterSeconds, 60);
  });

  await test('a blocked attempt is still recorded (keeps sliding the window forward)', async () => {
    let now = 3_000_000;
    const db = makeFakeDb(() => now);
    const check = { bucket: 'admin_login', identifier: 'ip:5.5.5.5', windowMs: 60_000, maxAttempts: 2 };
    await enforceRateLimit(db, [check]); // event #1
    now += 100;
    await enforceRateLimit(db, [check]); // event #2
    now += 100;
    const blocked = await enforceRateLimit(db, [check]); // 2 prior >= 2 -> blocked, but still recorded
    assert.ok(blocked);
    const matching = db.events.filter((e) => e.bucket === 'admin_login' && e.identifier === 'ip:5.5.5.5');
    assert.strictEqual(matching.length, 3, 'the blocked attempt itself should still be inserted');
  });

  await test('the window actually expires: an attempt outside the window is not counted', async () => {
    let now = 4_000_000;
    const db = makeFakeDb(() => now);
    const check = { bucket: 'otp_request', identifier: 'target:someone@example.com', windowMs: 60_000, maxAttempts: 2 };
    await enforceRateLimit(db, [check]); // event #1 at t=4_000_000
    now += 1_000;
    await enforceRateLimit(db, [check]); // event #2 at t=4_001_000
    now += 1_000; // t=4_002_000 -- both prior events are well within the 60s window
    let blocked = await enforceRateLimit(db, [check]); // this attempt is also recorded, at t=4_002_000
    assert.ok(blocked, 'should be blocked once 2 prior events sit inside the window');

    // Jump forward well past windowMs (60s) from every event recorded so far (the latest was at
    // t=4_002_000) -- every one of them must have aged out of the window by now.
    now += 61_000; // t=4_063_000
    blocked = await enforceRateLimit(db, [check]);
    assert.strictEqual(blocked, null, 'once every prior event has aged out of the window, the attempt should be allowed again');
  });

  await test('does not false-positive across different identifiers in the same bucket', async () => {
    let now = 5_000_000;
    const db = makeFakeDb(() => now);
    const checkA = { bucket: 'otp_request', identifier: 'target:alice@example.com', windowMs: 60_000, maxAttempts: 2 };
    const checkB = { bucket: 'otp_request', identifier: 'target:bob@example.com', windowMs: 60_000, maxAttempts: 2 };

    // Trip alice's limit.
    await enforceRateLimit(db, [checkA]);
    await enforceRateLimit(db, [checkA]);
    const aliceBlocked = await enforceRateLimit(db, [checkA]);
    assert.ok(aliceBlocked);

    // Bob, a completely different identifier in the same bucket, is unaffected.
    const bobBlocked = await enforceRateLimit(db, [checkB]);
    assert.strictEqual(bobBlocked, null);
  });

  await test('does not false-positive across different buckets for the same identifier', async () => {
    let now = 6_000_000;
    const db = makeFakeDb(() => now);
    const loginCheck = { bucket: 'admin_login', identifier: 'ip:1.1.1.1', windowMs: 60_000, maxAttempts: 1 };
    const otpCheck = { bucket: 'otp_request', identifier: 'ip:1.1.1.1', windowMs: 60_000, maxAttempts: 1 };

    const first = await enforceRateLimit(db, [loginCheck]);
    assert.strictEqual(first, null);
    const loginBlocked = await enforceRateLimit(db, [loginCheck]);
    assert.ok(loginBlocked, 'admin_login bucket should now be tripped for this IP');

    // Same IP, but a different bucket ('otp_request') -- its own independent counter.
    const otpBlocked = await enforceRateLimit(db, [otpCheck]);
    assert.strictEqual(otpBlocked, null);
  });

  await test('multiple checks in one call: every check must pass, and the FIRST exceeded one is reported', async () => {
    let now = 7_000_000;
    const db = makeFakeDb(() => now);
    const targetCheck = { bucket: 'otp_request', identifier: 'target:carol@example.com', windowMs: 60_000, maxAttempts: 1 };
    const ipCheck = { bucket: 'otp_request', identifier: 'ip:8.8.8.8', windowMs: 60_000, maxAttempts: 100 };

    await enforceRateLimit(db, [targetCheck, ipCheck]); // trips the target check (maxAttempts:1)
    const blocked = await enforceRateLimit(db, [targetCheck, ipCheck]);
    assert.ok(blocked);
    assert.strictEqual(blocked.identifier, 'target:carol@example.com');
    // The IP check (far from its own threshold) is still recorded even though it wasn't the blocker.
    const ipEvents = db.events.filter((e) => e.identifier === 'ip:8.8.8.8');
    assert.strictEqual(ipEvents.length, 2);
  });

  // ================================================================
  // rateLimitResponse
  // ================================================================

  await test('rateLimitResponse builds a 429 with a Retry-After header and retryAfterSeconds body field', () => {
    const res = rateLimitResponse({ retryAfterSeconds: 900 }, 'Too many login attempts. Please try again later.');
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.jsonBody.error, 'Too many login attempts. Please try again later.');
    assert.strictEqual(res.jsonBody.retryAfterSeconds, 900);
    assert.strictEqual(res.headers['Retry-After'], '900');
  });

  await test('rateLimitResponse falls back to a generic message when none is given', () => {
    const res = rateLimitResponse({ retryAfterSeconds: 60 });
    assert.ok(typeof res.jsonBody.error === 'string' && res.jsonBody.error.length > 0);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
