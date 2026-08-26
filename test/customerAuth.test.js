// Unit tests for lib/customerAuth.js — the customer session sign/verify round trip (incl. the
// embedded customerId), requireCustomer()'s cookie->auth-result wiring, optionalCustomerId()'s
// never-throws soft-lookup contract (what src/functions/book.js relies on), and the challenge-secret
// hash/compare helpers used by src/functions/auth/auth.js for magic-link tokens and OTP codes.
// No DB/HTTP involved — pure crypto/string logic, same "node --check + node test/foo.test.js"
// discipline as test/adminAuth.test.js.
//
// Run with: node test/customerAuth.test.js
'use strict';

const assert = require('assert');
const {
  SESSION_COOKIE_NAME,
  signCustomerSession,
  verifyCustomerSession,
  requireCustomer,
  optionalCustomerId,
  buildCustomerSessionCookie,
  clearCustomerSessionCookie,
  hashChallengeSecret,
  challengeSecretMatches,
} = require('../lib/customerAuth');

function fakeRequestWithCookie(cookieHeader) {
  return { headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookieHeader : null) } };
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

  // ---------------- signCustomerSession / verifyCustomerSession ----------------

  await test('signCustomerSession requires a secret and an integer customerId', () => {
    assert.throws(() => signCustomerSession(42, ''), /secret is required/);
    assert.throws(() => signCustomerSession('not-a-number', 'secret'), /customerId must be an integer/);
  });

  await test('a freshly signed token verifies and carries the right customerId', () => {
    const token = signCustomerSession(7, 'super-secret');
    const result = verifyCustomerSession(token, 'super-secret');
    assert.ok(result);
    assert.strictEqual(result.customerId, 7);
  });

  await test('verification fails against the wrong secret', () => {
    const token = signCustomerSession(7, 'super-secret');
    assert.strictEqual(verifyCustomerSession(token, 'wrong-secret'), null);
  });

  await test('a tampered payload is rejected (signature no longer matches)', () => {
    const token = signCustomerSession(7, 'super-secret');
    const [payloadB64, sigB64] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ cid: 999, exp: Date.now() + 999999999 })).toString('base64url');
    assert.notStrictEqual(tamperedPayload, payloadB64);
    assert.strictEqual(verifyCustomerSession(`${tamperedPayload}.${sigB64}`, 'super-secret'), null);
  });

  await test('an expired token is rejected', () => {
    const token = signCustomerSession(7, 'super-secret', -1000);
    assert.strictEqual(verifyCustomerSession(token, 'super-secret'), null);
  });

  await test('verifyCustomerSession rejects garbage/malformed input without throwing', () => {
    assert.strictEqual(verifyCustomerSession(undefined, 'super-secret'), null);
    assert.strictEqual(verifyCustomerSession(null, 'super-secret'), null);
    assert.strictEqual(verifyCustomerSession('not-a-real-token', 'super-secret'), null);
    assert.strictEqual(verifyCustomerSession('a.b.c', 'super-secret'), null);
    assert.strictEqual(verifyCustomerSession('', 'super-secret'), null);
    assert.strictEqual(verifyCustomerSession('abc.def', ''), null);
  });

  // ---------------- requireCustomer ----------------

  await test('requireCustomer returns 500 when CUSTOMER_SESSION_SECRET is unset', () => {
    const prev = process.env.CUSTOMER_SESSION_SECRET;
    delete process.env.CUSTOMER_SESSION_SECRET;
    try {
      const result = requireCustomer(fakeRequestWithCookie(''));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 500);
    } finally {
      if (prev !== undefined) process.env.CUSTOMER_SESSION_SECRET = prev;
    }
  });

  await test('requireCustomer returns 401 with no/invalid cookie, ok:true + customerId with a valid one', () => {
    process.env.CUSTOMER_SESSION_SECRET = 'test-secret';
    const noCookie = requireCustomer(fakeRequestWithCookie(''));
    assert.strictEqual(noCookie.ok, false);
    assert.strictEqual(noCookie.status, 401);

    const badCookie = requireCustomer(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=garbage`));
    assert.strictEqual(badCookie.ok, false);
    assert.strictEqual(badCookie.status, 401);

    const token = signCustomerSession(12, 'test-secret');
    const good = requireCustomer(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=${token}`));
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.customerId, 12);
  });

  // ---------------- optionalCustomerId (used by src/functions/book.js) ----------------

  await test('optionalCustomerId never throws and resolves null for missing config/cookie/invalid token', () => {
    const prev = process.env.CUSTOMER_SESSION_SECRET;
    delete process.env.CUSTOMER_SESSION_SECRET;
    try {
      assert.strictEqual(optionalCustomerId(fakeRequestWithCookie('')), null);
    } finally {
      if (prev !== undefined) process.env.CUSTOMER_SESSION_SECRET = prev;
    }

    process.env.CUSTOMER_SESSION_SECRET = 'test-secret';
    assert.strictEqual(optionalCustomerId(fakeRequestWithCookie('')), null);
    assert.strictEqual(optionalCustomerId(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=garbage`)), null);
    // A request object missing the expected shape entirely must not throw either.
    assert.strictEqual(optionalCustomerId({}), null);
  });

  await test('optionalCustomerId resolves the customerId for a valid cookie', () => {
    process.env.CUSTOMER_SESSION_SECRET = 'test-secret';
    const token = signCustomerSession(99, 'test-secret');
    assert.strictEqual(optionalCustomerId(fakeRequestWithCookie(`${SESSION_COOKIE_NAME}=${token}`)), 99);
  });

  // ---------------- cookie descriptors ----------------

  await test('buildCustomerSessionCookie / clearCustomerSessionCookie shapes', () => {
    const built = buildCustomerSessionCookie(5, 'test-secret');
    assert.strictEqual(built.name, SESSION_COOKIE_NAME);
    assert.strictEqual(built.httpOnly, true);
    assert.strictEqual(built.sameSite, 'Strict');
    assert.ok(built.maxAge > 0);
    const verified = verifyCustomerSession(built.value, 'test-secret');
    assert.strictEqual(verified.customerId, 5);

    const cleared = clearCustomerSessionCookie();
    assert.strictEqual(cleared.name, SESSION_COOKIE_NAME);
    assert.strictEqual(cleared.maxAge, 0);
  });

  // ---------------- challenge-secret hashing ----------------

  await test('hashChallengeSecret is deterministic and never stores the raw value', () => {
    const h1 = hashChallengeSecret('123456');
    const h2 = hashChallengeSecret('123456');
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, '123456');
    assert.strictEqual(h1.length, 64); // hex-encoded sha256
  });

  await test('challengeSecretMatches: true for the right secret, false otherwise', () => {
    const hash = hashChallengeSecret('654321');
    assert.strictEqual(challengeSecretMatches('654321', hash), true);
    assert.strictEqual(challengeSecretMatches('000000', hash), false);
    assert.strictEqual(challengeSecretMatches('654321', 'not-a-hex-hash!!'), false);
    assert.strictEqual(challengeSecretMatches('654321', null), false);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
