// Mocked-DB, mocked-ACS-SDK unit tests for src/functions/auth/auth.js (POST /api/auth/request,
// /api/auth/verify, /api/auth/logout). Follows the same require-cache-substitution approach as
// test/adminApi.test.js uses for `pg` — here it's applied to `pg`, lib/email.js, and lib/sms.js, so
// no real Postgres or Azure Communication Services call ever happens. lib/customerAuth.js is used
// for real (it's pure crypto, no I/O) so the hash/session round trip is exercised genuinely, not
// mocked away.
//
// Run with: node test/authApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const EMAIL_PATH = path.join(__dirname, '..', 'lib', 'email.js');
const SMS_PATH = path.join(__dirname, '..', 'lib', 'sms.js');
const AUTH_PATH = path.join(__dirname, '..', 'src', 'functions', 'auth', 'auth.js');

const { hashChallengeSecret, verifyCustomerSession, SESSION_COOKIE_NAME } = require('../lib/customerAuth');

// lib/rateLimit.js's rate_limit_events COUNT/INSERT (used by authRequestHandler's OTP_RATE_LIMIT) is
// backed here by a real, tiny in-memory sliding window per FakePool instance -- same approach as
// test/adminApi.test.js and test/rateLimit.test.js -- so a test that calls authRequestHandler more
// times than the threshold allows genuinely observes a 429, while the existing one-or-two-call tests
// below never get anywhere near tripping it. Neither query is pushed into `calls`.
function makeFakePool(queryImpl) {
  const calls = [];
  const rateLimitEvents = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
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
    }
  }
  return { FakePool, calls, rateLimitEvents };
}

function loadAuthHandlers(queryImpl, { sendMagicLinkEmail, sendOtpSms } = {}) {
  const { FakePool, calls, rateLimitEvents } = makeFakePool(queryImpl);

  delete require.cache[PG_PATH];
  delete require.cache[EMAIL_PATH];
  delete require.cache[SMS_PATH];
  delete require.cache[AUTH_PATH];

  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  const emailCalls = [];
  const fakeEmail = new Module(EMAIL_PATH);
  fakeEmail.exports = {
    sendMagicLinkEmail: async (toEmail, link) => {
      emailCalls.push({ toEmail, link });
      if (sendMagicLinkEmail) return sendMagicLinkEmail(toEmail, link);
    },
  };
  fakeEmail.loaded = true;
  require.cache[EMAIL_PATH] = fakeEmail;

  const smsCalls = [];
  const fakeSms = new Module(SMS_PATH);
  fakeSms.exports = {
    sendOtpSms: async (toPhone, code) => {
      smsCalls.push({ toPhone, code });
      if (sendOtpSms) return sendOtpSms(toPhone, code);
    },
  };
  fakeSms.loaded = true;
  require.cache[SMS_PATH] = fakeSms;

  const mod = require(AUTH_PATH);

  delete require.cache[PG_PATH];
  delete require.cache[EMAIL_PATH];
  delete require.cache[SMS_PATH];
  delete require.cache[AUTH_PATH];

  return { mod, calls, emailCalls, smsCalls, rateLimitEvents };
}

function fakeRequest({ body, ip } = {}) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    headers: { get: (name) => (name.toLowerCase() === 'x-forwarded-for' ? ip || null : null) },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
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

  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-secret';

  // ================================================================
  // POST /api/auth/request
  // ================================================================

  await test('request: 400 on invalid/missing method', async () => {
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    const res = await mod.authRequestHandler(fakeRequest({ body: { method: 'carrier-pigeon' } }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  await test('request: 400 on invalid email for method=email', async () => {
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    const res = await mod.authRequestHandler(fakeRequest({ body: { method: 'email', email: 'not-an-email' } }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  await test('request: 400 on missing phone for method=sms', async () => {
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    const res = await mod.authRequestHandler(fakeRequest({ body: { method: 'sms', phone: '' } }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  await test('request: email method, brand-new identifier — does NOT create a customer row, sends a magic link, reports isNewUser:true', async () => {
    const { mod, calls, emailCalls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE email/.test(sql)) return { rows: [] };
      if (/INSERT INTO auth_challenges/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authRequestHandler(
      fakeRequest({ body: { method: 'email', email: 'Someone@Example.com  ' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.ok, true);
    assert.strictEqual(res.jsonBody.isNewUser, true);
    assert.ok(!calls.some((c) => /INSERT INTO customers/.test(c.sql))); // no account created yet
    // normalized (trimmed + lowercased) before storage/send
    assert.strictEqual(emailCalls.length, 1);
    assert.strictEqual(emailCalls[0].toEmail, 'someone@example.com');
    assert.ok(/\/account\.html\?token=/.test(emailCalls[0].link));

    const challengeInsert = calls.find((c) => /INSERT INTO auth_challenges/.test(c.sql));
    assert.ok(challengeInsert);
    assert.strictEqual(challengeInsert.params[0], null); // customer_id — no customer exists yet
    assert.strictEqual(challengeInsert.params[1], 'email'); // method
    assert.strictEqual(challengeInsert.params[2], 'someone@example.com'); // identifier
    // the stored hash must NOT equal the raw token embedded in the emailed link
    const sentToken = emailCalls[0].link.split('token=')[1];
    assert.notStrictEqual(challengeInsert.params[3], decodeURIComponent(sentToken));
    assert.strictEqual(challengeInsert.params[3], hashChallengeSecret(decodeURIComponent(sentToken)));
  });

  await test('request: email method, already-known identifier — reports isNewUser:false and links the challenge to the existing customer', async () => {
    const { mod, calls } = loadAuthHandlers(async (sql, params) => {
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE email/.test(sql)) {
        return { rows: [{ id: 9, name: 'Jamie Rivera', email: params[0], phone: null, created_at: 'now' }] };
      }
      return { rows: [] };
    });
    const res = await mod.authRequestHandler(fakeRequest({ body: { method: 'email', email: 'jamie@example.com' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.isNewUser, false);
    const challengeInsert = calls.find((c) => /INSERT INTO auth_challenges/.test(c.sql));
    assert.strictEqual(challengeInsert.params[0], 9); // customer_id — the existing customer
  });

  await test('request: sms method, brand-new identifier — generates a 6-digit code, texts it, storing only its hash, reports isNewUser:true', async () => {
    const { mod, calls, smsCalls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE phone/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authRequestHandler(fakeRequest({ body: { method: 'sms', phone: ' (267) 555-0100 ' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.isNewUser, true);
    assert.ok(!calls.some((c) => /INSERT INTO customers/.test(c.sql)));
    assert.strictEqual(smsCalls.length, 1);
    assert.ok(/^\d{6}$/.test(smsCalls[0].code));
    // normalizePhone() canonicalizes to "+1<10 digits>" (lib/phone.js) — both so this identifier
    // compares equal to however it gets typed elsewhere (booking form, retroactive-linking match),
    // and, as a side effect, so what actually goes out over ACS SMS is real E.164 (lib/sms.js's
    // sendOtpSms/sendReminderSms both document that as their expected input format).
    assert.strictEqual(smsCalls[0].toPhone, '+12675550100');

    const challengeInsert = calls.find((c) => /INSERT INTO auth_challenges/.test(c.sql));
    assert.strictEqual(challengeInsert.params[0], null); // customer_id — no customer exists yet
    assert.strictEqual(challengeInsert.params[1], 'sms');
    assert.strictEqual(challengeInsert.params[2], '+12675550100'); // identifier — normalized, not raw
    assert.strictEqual(challengeInsert.params[3], hashChallengeSecret(smsCalls[0].code));
  });

  await test('request: 500 when the send itself fails (ACS not configured / delivery error)', async () => {
    const { mod } = loadAuthHandlers(
      async () => ({ rows: [] }),
      { sendMagicLinkEmail: async () => { throw new Error('ACS_EMAIL_CONNECTION_STRING not configured'); } }
    );
    const res = await mod.authRequestHandler(fakeRequest({ body: { method: 'email', email: 'x@example.com' } }), fakeContext());
    assert.strictEqual(res.status, 500);
  });

  await test('request: rate-limited per target identifier once maxAttemptsPerTarget is hit, even across many different IPs', async () => {
    const { OTP_RATE_LIMIT } = require(AUTH_PATH);
    const { mod, smsCalls } = loadAuthHandlers(async () => ({ rows: [] }));
    for (let i = 0; i < OTP_RATE_LIMIT.maxAttemptsPerTarget; i++) {
      const res = await mod.authRequestHandler(
        fakeRequest({ body: { method: 'sms', phone: '2675550100' }, ip: `203.0.113.${i}` }),
        fakeContext()
      );
      assert.strictEqual(res.status, 200, `attempt ${i + 1} for this phone number should still succeed`);
    }
    const blocked = await mod.authRequestHandler(
      fakeRequest({ body: { method: 'sms', phone: '2675550100' }, ip: '203.0.113.250' }),
      fakeContext()
    );
    assert.strictEqual(blocked.status, 429);
    assert.ok(typeof blocked.jsonBody.retryAfterSeconds === 'number');
    // no further SMS should have gone out for the blocked attempt
    assert.strictEqual(smsCalls.length, OTP_RATE_LIMIT.maxAttemptsPerTarget);
  });

  await test('request: rate-limited per IP once maxAttemptsPerIp is hit, even across many different target identifiers', async () => {
    const { OTP_RATE_LIMIT } = require(AUTH_PATH);
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    for (let i = 0; i < OTP_RATE_LIMIT.maxAttemptsPerIp; i++) {
      const res = await mod.authRequestHandler(
        fakeRequest({ body: { method: 'email', email: `victim-${i}@example.com` }, ip: '198.51.100.20' }),
        fakeContext()
      );
      assert.strictEqual(res.status, 200);
    }
    const blocked = await mod.authRequestHandler(
      fakeRequest({ body: { method: 'email', email: 'yet-another-victim@example.com' }, ip: '198.51.100.20' }),
      fakeContext()
    );
    assert.strictEqual(blocked.status, 429);
  });

  await test('request: a different target identifier on a fresh IP is unaffected by another identifier\'s rate limit', async () => {
    const { OTP_RATE_LIMIT } = require(AUTH_PATH);
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    for (let i = 0; i < OTP_RATE_LIMIT.maxAttemptsPerTarget; i++) {
      await mod.authRequestHandler(fakeRequest({ body: { method: 'sms', phone: '2675550100' }, ip: '198.51.100.30' }), fakeContext());
    }
    const unrelated = await mod.authRequestHandler(
      fakeRequest({ body: { method: 'sms', phone: '2675550199' }, ip: '198.51.100.31' }),
      fakeContext()
    );
    assert.strictEqual(unrelated.status, 200);
  });

  // ================================================================
  // POST /api/auth/verify
  // ================================================================

  await test('verify: 500 when CUSTOMER_SESSION_SECRET unset', async () => {
    const prev = process.env.CUSTOMER_SESSION_SECRET;
    delete process.env.CUSTOMER_SESSION_SECRET;
    try {
      const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
      const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: 'x' } }), fakeContext());
      assert.strictEqual(res.status, 500);
    } finally {
      process.env.CUSTOMER_SESSION_SECRET = prev;
    }
  });

  await test('verify: email — 401 when no matching unused/unexpired challenge exists', async () => {
    const { mod } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: 'nope' } }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('verify: email — returning customer (customer_id already set) — 200 + session cookie; marks the challenge used, does not create a customer, isNewUser:false', async () => {
    const rawToken = 'a-very-random-magic-link-token';
    const secretHash = hashChallengeSecret(rawToken);
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 55, customer_id: 8, identifier: 'x@example.com', secret_hash: secretHash }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 8, name: null, email: 'x@example.com', phone: null, created_at: 'now' }] };
      }
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: rawToken } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.id, 8);
    assert.strictEqual(res.jsonBody.customer.number, 'AFD-000008');
    assert.strictEqual(res.jsonBody.isNewUser, false);
    assert.ok(Array.isArray(res.cookies) && res.cookies.length === 1);
    assert.strictEqual(res.cookies[0].name, SESSION_COOKIE_NAME);
    const verified = verifyCustomerSession(res.cookies[0].value, process.env.CUSTOMER_SESSION_SECRET);
    assert.strictEqual(verified.customerId, 8);

    const usedUpdate = calls.find((c) => /UPDATE auth_challenges SET used_at/.test(c.sql));
    assert.deepStrictEqual(usedUpdate.params, [55]);
    assert.ok(!calls.some((c) => /INSERT INTO customers/.test(c.sql))); // never created — already existed
  });

  await test('verify: email — brand-new identifier (challenge.customer_id NULL) — creates the customer now, backfills the challenge, isNewUser:true', async () => {
    const rawToken = 'a-fresh-signup-magic-link-token';
    const secretHash = hashChallengeSecret(rawToken);
    const { mod, calls } = loadAuthHandlers(async (sql, params) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 77, customer_id: null, identifier: 'newperson@example.com', secret_hash: secretHash }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/INSERT INTO customers \(email\)/.test(sql)) {
        return { rows: [{ id: 21, name: null, email: params[0], phone: null, created_at: 'now' }] };
      }
      if (/UPDATE auth_challenges SET customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: rawToken } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.isNewUser, true);
    assert.strictEqual(res.jsonBody.customer.id, 21);
    assert.strictEqual(res.jsonBody.customer.name, null); // no name yet — account.html prompts for it next
    assert.strictEqual(res.jsonBody.customer.number, 'AFD-000021');
    const verified = verifyCustomerSession(res.cookies[0].value, process.env.CUSTOMER_SESSION_SECRET);
    assert.strictEqual(verified.customerId, 21);

    const customerInsert = calls.find((c) => /INSERT INTO customers \(email\)/.test(c.sql));
    assert.deepStrictEqual(customerInsert.params, ['newperson@example.com']);
    const backfill = calls.find((c) => /UPDATE auth_challenges SET customer_id/.test(c.sql));
    assert.deepStrictEqual(backfill.params, [21, 77]);
  });

  await test('verify: sms — 400 when phone or code missing', async () => {
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '', code: '123456' } }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  await test('verify: sms — 401 + increments attempts on a wrong code', async () => {
    const secretHash = hashChallengeSecret('111111');
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, secret_hash, attempts FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 9, customer_id: 4, secret_hash: secretHash, attempts: 0 }] };
      }
      if (/UPDATE auth_challenges SET attempts/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '2675550100', code: '000000' } }), fakeContext());
    assert.strictEqual(res.status, 401);
    const attemptsUpdate = calls.find((c) => /UPDATE auth_challenges SET attempts/.test(c.sql));
    assert.deepStrictEqual(attemptsUpdate.params, [9]);
  });

  await test('verify: sms — 429 once MAX_OTP_ATTEMPTS is reached, without even checking the code', async () => {
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, secret_hash, attempts FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 10, customer_id: 4, secret_hash: hashChallengeSecret('111111'), attempts: 5 }] };
      }
      return { rows: [] };
    });
    assert.strictEqual(mod.MAX_OTP_ATTEMPTS, 5); // keep the fixture's attempts count above in sync
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '2675550100', code: '111111' } }), fakeContext());
    assert.strictEqual(res.status, 429);
    assert.ok(!calls.some((c) => /UPDATE auth_challenges/.test(c.sql)));
  });

  await test('verify: sms — returning customer — 200 + session cookie on a correct code; marks the challenge used, isNewUser:false', async () => {
    const secretHash = hashChallengeSecret('654321');
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, secret_hash, attempts FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 11, customer_id: 6, secret_hash: secretHash, attempts: 2 }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 6, name: null, email: null, phone: '2675550100', created_at: 'now' }] };
      }
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '2675550100', code: '654321' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.id, 6);
    assert.strictEqual(res.jsonBody.isNewUser, false);
    assert.ok(Array.isArray(res.cookies) && res.cookies.length === 1);
    const usedUpdate = calls.find((c) => /UPDATE auth_challenges SET used_at/.test(c.sql));
    assert.deepStrictEqual(usedUpdate.params, [11]);
    assert.ok(!calls.some((c) => /INSERT INTO customers/.test(c.sql)));
  });

  await test('verify: sms — brand-new identifier (challenge.customer_id NULL) — creates the customer using the verified phone, isNewUser:true', async () => {
    const secretHash = hashChallengeSecret('111222');
    const { mod, calls } = loadAuthHandlers(async (sql, params) => {
      if (/SELECT id, customer_id, secret_hash, attempts FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 88, customer_id: null, secret_hash: secretHash, attempts: 0 }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/INSERT INTO customers \(phone\)/.test(sql)) {
        return { rows: [{ id: 33, name: null, email: null, phone: params[0], created_at: 'now' }] };
      }
      if (/UPDATE auth_challenges SET customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '2675550199', code: '111222' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.isNewUser, true);
    assert.strictEqual(res.jsonBody.customer.id, 33);
    assert.strictEqual(res.jsonBody.customer.number, 'AFD-000033');
    const customerInsert = calls.find((c) => /INSERT INTO customers \(phone\)/.test(c.sql));
    // normalized (lib/phone.js), not the raw 10-digit string that was submitted
    assert.deepStrictEqual(customerInsert.params, ['+12675550199']);
    const backfill = calls.find((c) => /UPDATE auth_challenges SET customer_id/.test(c.sql));
    assert.deepStrictEqual(backfill.params, [33, 88]);
  });

  // ================================================================
  // Retroactive guest-appointment linking (runs inside resolveVerifiedCustomer, on every
  // successful verify — see src/functions/auth/auth.js's linkOrphanGuestAppointments comment)
  // ================================================================

  await test('verify: email, existing-customer branch — links orphaned guest appointments matching that email, guarded by customer_id IS NULL', async () => {
    const rawToken = 'existing-customer-link-token';
    const secretHash = hashChallengeSecret(rawToken);
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 60, customer_id: 8, identifier: 'jamie@example.com', secret_hash: secretHash }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 8, name: 'Jamie', email: 'jamie@example.com', phone: null, created_at: 'now' }] };
      }
      if (/UPDATE appointments SET customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: rawToken } }), fakeContext());
    assert.strictEqual(res.status, 200);

    const linkUpdate = calls.find((c) => /UPDATE appointments SET customer_id/.test(c.sql));
    assert.ok(linkUpdate, 'expected an UPDATE appointments ... SET customer_id query');
    assert.ok(/customer_id IS NULL/.test(linkUpdate.sql), 'guard clause must be present so already-linked rows are never touched');
    assert.ok(/LOWER\(customer_email\)/.test(linkUpdate.sql), 'email match must be case-insensitive');
    assert.deepStrictEqual(linkUpdate.params, [8, 'jamie@example.com']);
  });

  await test('verify: email, brand-new-signup branch — also links orphaned guest appointments (fires identically on both branches)', async () => {
    const rawToken = 'new-signup-link-token';
    const secretHash = hashChallengeSecret(rawToken);
    const { mod, calls } = loadAuthHandlers(async (sql, params) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 61, customer_id: null, identifier: 'newperson@example.com', secret_hash: secretHash }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/INSERT INTO customers \(email\)/.test(sql)) {
        return { rows: [{ id: 22, name: null, email: params[0], phone: null, created_at: 'now' }] };
      }
      if (/UPDATE auth_challenges SET customer_id/.test(sql)) return { rows: [] };
      if (/UPDATE appointments SET customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: rawToken } }), fakeContext());
    assert.strictEqual(res.status, 200);

    const linkUpdate = calls.find((c) => /UPDATE appointments SET customer_id/.test(c.sql));
    assert.ok(linkUpdate, 'the new-signup branch must also attempt retroactive linking');
    assert.deepStrictEqual(linkUpdate.params, [22, 'newperson@example.com']);
  });

  await test('verify: email — no matching guest appointments is a clean no-op (no error, verify still succeeds)', async () => {
    const rawToken = 'no-match-token';
    const secretHash = hashChallengeSecret(rawToken);
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 62, customer_id: 4, identifier: 'noone@example.com', secret_hash: secretHash }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 4, name: null, email: 'noone@example.com', phone: null, created_at: 'now' }] };
      }
      // Simulates zero rows matched — a real UPDATE with no matching WHERE rows still resolves fine,
      // returning an empty rowCount, not an error.
      if (/UPDATE appointments SET customer_id/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: rawToken } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.ok(calls.some((c) => /UPDATE appointments SET customer_id/.test(c.sql)));
  });

  await test('verify: sms — links only phone-matched guest appointments (using the normalized identifier), never cross-matching on email', async () => {
    const secretHash = hashChallengeSecret('222333');
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, secret_hash, attempts FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 63, customer_id: 15, secret_hash: secretHash, attempts: 0 }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 15, name: null, email: null, phone: '+12675550188', created_at: 'now' }] };
      }
      if (/UPDATE appointments SET customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '2675550188', code: '222333' } }), fakeContext());
    assert.strictEqual(res.status, 200);

    const linkUpdate = calls.find((c) => /UPDATE appointments SET customer_id/.test(c.sql));
    assert.ok(linkUpdate);
    assert.ok(/customer_phone = \$2/.test(linkUpdate.sql));
    assert.ok(!/customer_email/.test(linkUpdate.sql), 'sms verification must never match on the email column');
    // the raw 10-digit '2675550188' submitted gets normalized (lib/phone.js) before being used as
    // the match param — this is what makes it comparable to a differently-formatted number stored at
    // booking time (see the next test).
    assert.deepStrictEqual(linkUpdate.params, [15, '+12675550188']);
  });

  await test('verify: sms — a phone typed in one format at booking still links against a differently-formatted-but-same-number phone proven at verify', async () => {
    // Simulates the exact scenario this whole normalization pass was added for: the guest booked
    // with "(267) 555-0188" typed into book.html's contact form (src/functions/book.js now stores
    // that normalized via lib/phone.js, so the appointment's customer_email/customer_phone would
    // really be "+12675550188" in the DB — but this test is about the LINKING match itself, so what
    // matters here is that whatever raw shape verify receives gets normalized to the very same
    // canonical form before being used as the UPDATE's match param).
    const secretHash = hashChallengeSecret('333444');
    const { mod, calls } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, secret_hash, attempts FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 65, customer_id: 16, secret_hash: secretHash, attempts: 0 }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 16, name: null, email: null, phone: '+12675550188', created_at: 'now' }] };
      }
      if (/UPDATE appointments SET customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    // Verifying with a DIFFERENT typed shape than the "(267) 555-0188" used above — dashes instead of
    // parens/spaces — same underlying number.
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'sms', phone: '267-555-0188', code: '333444' } }), fakeContext());
    assert.strictEqual(res.status, 200);

    const linkUpdate = calls.find((c) => /UPDATE appointments SET customer_id/.test(c.sql));
    assert.ok(linkUpdate);
    // Both shapes normalize to the same canonical value — this is the param the UPDATE actually runs
    // with, which is what lets it match a customer_phone column written from either typed shape.
    assert.deepStrictEqual(linkUpdate.params, [16, '+12675550188']);
  });

  await test('verify: linking failure is swallowed — verify still returns 200 + a session cookie rather than 500ing an already-successful sign-in', async () => {
    const rawToken = 'link-failure-token';
    const secretHash = hashChallengeSecret(rawToken);
    const { mod } = loadAuthHandlers(async (sql) => {
      if (/SELECT id, customer_id, identifier, secret_hash FROM auth_challenges/.test(sql)) {
        return { rows: [{ id: 64, customer_id: 5, identifier: 'flaky@example.com', secret_hash: secretHash }] };
      }
      if (/UPDATE auth_challenges SET used_at/.test(sql)) return { rows: [] };
      if (/SELECT id, name, email, phone, created_at FROM customers WHERE id/.test(sql)) {
        return { rows: [{ id: 5, name: null, email: 'flaky@example.com', phone: null, created_at: 'now' }] };
      }
      if (/UPDATE appointments SET customer_id/.test(sql)) throw new Error('simulated transient DB error');
      return { rows: [] };
    });
    const res = await mod.authVerifyHandler(fakeRequest({ body: { method: 'email', token: rawToken } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.cookies) && res.cookies.length === 1);
  });

  await test('linkOrphanGuestAppointments: an appointment already linked to a different customer is guarded by customer_id IS NULL in the query text (not just by convention)', async () => {
    const queries = [];
    const fakeDb = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    await mod.linkOrphanGuestAppointments(fakeDb, { customerId: 99, method: 'email', identifier: 'x@example.com' });
    assert.strictEqual(queries.length, 2, 'expected the appointments link + the billing_entries sync');
    assert.ok(/WHERE customer_id IS NULL AND LOWER\(customer_email\) = \$2/.test(queries[0].sql));
    assert.deepStrictEqual(queries[0].params, [99, 'x@example.com']);
  });

  await test('linkOrphanGuestAppointments: also syncs billing_entries.customer_id for entries recorded against an appointment before it was linked', async () => {
    // Reproduces a real production case: admin.html logs a manual payment against a guest
    // appointment (billing_entries.customer_id copies the appointment's customer_id at INSERT time,
    // which was NULL) — the appointment later gets linked by this function, but without this second
    // step the payment stays orphaned (customer_id NULL) forever, invisible in GET /api/account/billing
    // (which filters strictly on customer_id) even though the appointment itself now shows up fine.
    const queries = [];
    const fakeDb = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    await mod.linkOrphanGuestAppointments(fakeDb, { customerId: 3, method: 'email', identifier: 'wintee4849@gmail.com' });
    assert.strictEqual(queries.length, 2);
    const billingSync = queries[1];
    assert.ok(/UPDATE billing_entries/.test(billingSync.sql));
    assert.ok(/be\.customer_id IS NULL/.test(billingSync.sql), 'must never overwrite a billing_entries row that already has a customer_id');
    assert.ok(/a\.customer_id = \$1/.test(billingSync.sql), 'driven off the appointment\'s own (now-linked) customer_id, not the original identifier match');
    assert.deepStrictEqual(billingSync.params, [3]);
  });

  await test('linkOrphanGuestAppointments: sms branch also runs the billing_entries sync', async () => {
    const queries = [];
    const fakeDb = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    await mod.linkOrphanGuestAppointments(fakeDb, { customerId: 44, method: 'sms', identifier: '+12675550188' });
    assert.strictEqual(queries.length, 2);
    assert.ok(/UPDATE billing_entries/.test(queries[1].sql));
    assert.deepStrictEqual(queries[1].params, [44]);
  });

  await test('linkOrphanGuestAppointments: a failure in the billing_entries sync is swallowed the same way as an appointments-link failure', async () => {
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    const fakeDb = {
      query: async (sql) => {
        if (/UPDATE billing_entries/.test(sql)) throw new Error('simulated transient DB error');
        return { rows: [] };
      },
    };
    // Must not throw — same non-fatal, log-and-continue contract as the appointments-link step.
    await mod.linkOrphanGuestAppointments(fakeDb, { customerId: 7, method: 'email', identifier: 'x@example.com' });
  });

  // ================================================================
  // POST /api/auth/logout
  // ================================================================

  await test('logout: always 200, clears the cookie (maxAge 0)', async () => {
    const { mod } = loadAuthHandlers(async () => ({ rows: [] }));
    const res = await mod.authLogoutHandler();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.cookies[0].name, SESSION_COOKIE_NAME);
    assert.strictEqual(res.cookies[0].maxAge, 0);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
