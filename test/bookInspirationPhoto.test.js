// Mocked-DB unit test for src/functions/book.js's ADDITIVE inspirationPhotoUrl handling: an optional
// `inspirationPhotoUrl` in the booking payload (from a prior POST /api/upload-inspiration-photo call)
// gets persisted onto the new appointment row only if it actually points into the configured
// inspiration-photos blob container -- an arbitrary client-supplied URL must be rejected, and omitting
// the field entirely must still work exactly as before this feature existed (inspiration_photo_url
// stays null).
//
// Same require-cache-substitution approach as test/bookingLinkage.test.js: `pg`'s Pool/Client is faked,
// no real Postgres involved. lib/availability.js's computeSlots()/zonedWallTimeToUtc() run for REAL
// (both are pure, no I/O).
//
// Run with: node test/bookInspirationPhoto.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const BOOK_PATH = path.join(__dirname, '..', 'src', 'functions', 'book.js');

const { zonedWallTimeToUtc, weekdayOf } = require('../lib/availability');

const TIMEZONE = 'America/New_York';
const BLOB_ENDPOINT = 'https://afdfnmockaccount.blob.core.windows.net';
const CONTAINER = 'inspiration-photos';
const VALID_PHOTO_URL = `${BLOB_ENDPOINT}/${CONTAINER}/abc123def456.png?sv=mock-sas-token`;

// A fixed future Tuesday -- same fixture shape as test/bookingLinkage.test.js.
const YEAR = 2027, MONTH = 6, DAY = 1; // 2027-06-01
const WEEKDAY = weekdayOf(YEAR, MONTH, DAY);
const REQUESTED_START = zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE);

function makeFakePool(insertCapture) {
  class FakeClient {
    async query(sql, params) {
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
            customer_id: params[10], inspiration_photo_url: params[11], created_at: new Date().toISOString(),
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
  return { FakePool };
}

function loadBookHandler(insertCapture) {
  const { FakePool } = makeFakePool(insertCapture);
  delete require.cache[PG_PATH];
  delete require.cache[BOOK_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(BOOK_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[BOOK_PATH];
  return mod;
}

function fakeRequest(body) {
  return {
    json: async () => body,
    headers: { get: () => '' },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
}

function baseBody(extra) {
  return Object.assign({
    serviceId: 1,
    customerName: 'Jamie Customer',
    customerPhone: '2675550100',
    customerEmail: 'jamie@example.com',
    start: REQUESTED_START.toISOString(),
    smsOptIn: false,
  }, extra);
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

  await test('no inspirationPhotoUrl -> column stays null (unchanged behavior for photo-less bookings)', async () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const capture = {};
    const mod = loadBookHandler(capture);
    const res = await mod.bookHandler(fakeRequest(baseBody()), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[11], null);
    assert.strictEqual(res.jsonBody.appointment.inspiration_photo_url, null);
  });

  await test('a valid inspiration-photos URL -> persisted onto the new appointment', async () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const capture = {};
    const mod = loadBookHandler(capture);
    const res = await mod.bookHandler(fakeRequest(baseBody({ inspirationPhotoUrl: VALID_PHOTO_URL })), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[11], VALID_PHOTO_URL);
    assert.strictEqual(res.jsonBody.appointment.inspiration_photo_url, VALID_PHOTO_URL);
  });

  await test('an arbitrary/untrusted URL (not pointing at the configured container) -> 400, never persisted', async () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const mod = loadBookHandler({});
    const attempts = [
      'https://evil.example.com/inspiration-photos/x.png',
      'https://afdfnmockaccount.blob.core.windows.net/some-other-container/x.png',
      'not-even-a-url',
      'data:image/png;base64,AAAA',
    ];
    for (const bad of attempts) {
      const res = await mod.bookHandler(fakeRequest(baseBody({ inspirationPhotoUrl: bad })), fakeContext());
      assert.strictEqual(res.status, 400, `expected 400 for "${bad}", got ${res.status}: ${JSON.stringify(res.jsonBody)}`);
      assert.ok(res.jsonBody.details.some((d) => /inspirationPhotoUrl/.test(d)));
    }
  });

  await test('INSPIRATION_PHOTOS_BLOB_ENDPOINT unconfigured -> any inspirationPhotoUrl is rejected (fails closed, not open)', async () => {
    delete process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT;
    const mod = loadBookHandler({});
    const res = await mod.bookHandler(fakeRequest(baseBody({ inspirationPhotoUrl: VALID_PHOTO_URL })), fakeContext());
    assert.strictEqual(res.status, 400);
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT; // restore for any tests after this one
  });

  await test('a non-string inspirationPhotoUrl -> 400', async () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const mod = loadBookHandler({});
    const res = await mod.bookHandler(fakeRequest(baseBody({ inspirationPhotoUrl: 12345 })), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
