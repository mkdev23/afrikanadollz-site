// Mocked-DB unit test for src/functions/book.js's ADDITIVE customer-account linkage: if a valid
// customer session cookie is present on the booking request, the new appointment's customer_id
// column should be set to that session's customer_id; otherwise (no cookie, invalid/expired cookie,
// or CUSTOMER_SESSION_SECRET unconfigured) it stays null — a guest booking, exactly as before this
// feature existed. Everything else about bookHandler (the advisory-lock race guard, slot
// re-validation, etc.) is exercised here only incidentally, as the necessary path to reach the
// INSERT — it is NOT the focus of this test and isn't re-verified in depth.
//
// Same require-cache-substitution approach as test/adminApi.test.js: `pg`'s Pool/Client is faked, no
// real Postgres involved. lib/customerAuth.js's optionalCustomerId() and lib/availability.js's
// computeSlots()/zonedWallTimeToUtc() run for REAL (both are pure, no I/O) so the actual linkage
// wiring in book.js is what's under test, not a stand-in for it.
//
// Run with: node test/bookingLinkage.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const BOOK_PATH = path.join(__dirname, '..', 'src', 'functions', 'book.js');

const { signCustomerSession, SESSION_COOKIE_NAME } = require('../lib/customerAuth');
const { zonedWallTimeToUtc, weekdayOf } = require('../lib/availability');

const TIMEZONE = 'America/New_York';

// A fixed future Tuesday, well past "today" regardless of when this test runs (schema/test dates
// elsewhere in this session use 2026 as the working year) — 09:00-17:00 local hours, a 60-minute
// service with no buffer, requested start at 10:00 local (a clean slot boundary: 09:00-10:00 is the
// first slot, so 10:00 is exactly where the second one begins).
const YEAR = 2027, MONTH = 6, DAY = 1; // 2027-06-01
const WEEKDAY = weekdayOf(YEAR, MONTH, DAY);
const REQUESTED_START = zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE);

function makeFakePool(insertCapture) {
  const calls = [];
  class FakeClient {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^BEGIN/.test(sql)) return {};
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM services/.test(sql)) {
        return { rows: [{ id: 1, name: 'Braids', duration_min: 60, buffer_min: 0 }] };
      }
      if (/FROM blocked_slots/.test(sql)) return { rows: [] };
      if (/FROM appointments/.test(sql) && /status = 'confirmed'/.test(sql)) return { rows: [] };
      if (/FROM availability_rules/.test(sql)) {
        return { rows: [{ weekday: WEEKDAY, start_time: '09:00:00', end_time: '17:00:00' }] };
      }
      if (/^INSERT INTO appointments/.test(sql)) {
        insertCapture.params = params;
        return {
          rows: [{
            id: 42, service_id: params[0], customer_name: params[1], customer_phone: params[2],
            customer_email: params[3], notes: params[4], start_at: params[5], end_at: params[6],
            status: 'confirmed', sms_opt_in: params[7], sms_phone: params[8], manage_token: params[9],
            customer_id: params[10], created_at: new Date().toISOString(),
          }],
        };
      }
      if (/^COMMIT/.test(sql)) return {};
      if (/^ROLLBACK/.test(sql)) return {};
      return { rows: [] };
    }
    release() {}
  }
  class FakePool {
    constructor() {}
    async connect() {
      return new FakeClient();
    }
  }
  return { FakePool, calls };
}

function loadBookHandler(insertCapture) {
  const { FakePool, calls } = makeFakePool(insertCapture);
  delete require.cache[PG_PATH];
  delete require.cache[BOOK_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(BOOK_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[BOOK_PATH];
  return { mod, calls };
}

function fakeRequest({ body, cookie } = {}) {
  return {
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : null) },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
}

function baseBody() {
  return {
    serviceId: 1,
    customerName: 'Jamie Customer',
    customerPhone: '2675550100',
    customerEmail: 'jamie@example.com',
    start: REQUESTED_START.toISOString(),
    smsOptIn: false,
  };
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

  await test('sanity: the fixture slot is actually offered (booking succeeds with no cookie at all)', async () => {
    const capture = {};
    const { mod } = loadBookHandler(capture);
    const res = await mod.bookHandler(fakeRequest({ body: baseBody() }), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
  });

  await test('no session cookie -> customer_id stays null (guest booking, unchanged behavior)', async () => {
    const capture = {};
    const { mod } = loadBookHandler(capture);
    const res = await mod.bookHandler(fakeRequest({ body: baseBody() }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(capture.params[10], null);
    assert.strictEqual(res.jsonBody.appointment.customer_id, null);
  });

  await test('a valid customer session cookie -> customer_id is attached to the new appointment', async () => {
    const capture = {};
    const { mod } = loadBookHandler(capture);
    const cookie = `${SESSION_COOKIE_NAME}=${signCustomerSession(123, 'test-customer-secret')}`;
    const res = await mod.bookHandler(fakeRequest({ body: baseBody(), cookie }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(capture.params[10], 123);
    assert.strictEqual(res.jsonBody.appointment.customer_id, 123);
  });

  await test('an invalid/tampered session cookie -> falls back to guest (null), never errors the booking', async () => {
    const capture = {};
    const { mod } = loadBookHandler(capture);
    const cookie = `${SESSION_COOKIE_NAME}=not-a-real-token`;
    const res = await mod.bookHandler(fakeRequest({ body: baseBody(), cookie }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(capture.params[10], null);
  });

  await test('an expired session cookie -> falls back to guest (null)', async () => {
    const capture = {};
    const { mod } = loadBookHandler(capture);
    const cookie = `${SESSION_COOKIE_NAME}=${signCustomerSession(123, 'test-customer-secret', -1000)}`;
    const res = await mod.bookHandler(fakeRequest({ body: baseBody(), cookie }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(capture.params[10], null);
  });

  await test('CUSTOMER_SESSION_SECRET unconfigured -> falls back to guest (null), booking still works', async () => {
    const prev = process.env.CUSTOMER_SESSION_SECRET;
    delete process.env.CUSTOMER_SESSION_SECRET;
    try {
      const capture = {};
      const { mod } = loadBookHandler(capture);
      const cookie = `${SESSION_COOKIE_NAME}=${signCustomerSession(123, prev)}`;
      const res = await mod.bookHandler(fakeRequest({ body: baseBody(), cookie }), fakeContext());
      assert.strictEqual(res.status, 201);
      assert.strictEqual(capture.params[10], null);
    } finally {
      process.env.CUSTOMER_SESSION_SECRET = prev;
    }
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
