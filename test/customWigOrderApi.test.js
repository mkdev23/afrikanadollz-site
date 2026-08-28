// Mocked-DB unit tests for src/functions/customWigOrder.js (POST /api/custom-wig-order — the fully
// custom wig order intake, NOT a time-slot appointment; see that file's header comment). Same
// require-cache-substitution approach as test/adminClientsApi.test.js: `pg`'s Pool is faked, no real
// Postgres involved. lib/customerAuth.js's optionalCustomerId() and lib/phone.js's normalizePhone()
// run for REAL (both are pure, no I/O) so the actual guest/logged-in linkage and phone-normalization
// wiring is what's under test, not a stand-in for it. lib/email.js's send path is exercised through
// the real module too, unmocked — with no ACS_EMAIL_CONNECTION_STRING configured (never set in this
// file) it silently no-ops, which is exactly how test/bookingLinkage.test.js and friends already cover
// book.js's identical "an email hiccup never turns a successful write into a 500" property.
//
// Run with: node test/customWigOrderApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const ORDER_PATH = path.join(__dirname, '..', 'src', 'functions', 'customWigOrder.js');

const { signCustomerSession, SESSION_COOKIE_NAME } = require('../lib/customerAuth');

const BLOB_ENDPOINT = 'https://afdfnmockaccount.blob.core.windows.net';
const CONTAINER = 'inspiration-photos';
const VALID_PHOTO_URL = `${BLOB_ENDPOINT}/${CONTAINER}/abc123def456.png?sv=mock-sas-token`;

// custom_wig_orders' column order, matching the INSERT in src/functions/customWigOrder.js exactly:
// customer_name, customer_phone, customer_email, customer_id, circumference_in, front_to_nape_in,
// ear_to_ear_forehead_in, ear_to_ear_top_in, temple_to_temple_in, nape_of_neck_in, cap_size,
// lace_style, style_notes, reference_photo_url.
const COL = {
  NAME: 0, PHONE: 1, EMAIL: 2, CUSTOMER_ID: 3,
  CIRCUMFERENCE: 4, FRONT_TO_NAPE: 5, EAR_TO_EAR_FOREHEAD: 6, EAR_TO_EAR_TOP: 7,
  TEMPLE_TO_TEMPLE: 8, NAPE_OF_NECK: 9, CAP_SIZE: 10, LACE_STYLE: 11, STYLE_NOTES: 12, PHOTO: 13,
};

function makeFakePool(insertCapture) {
  const calls = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^INSERT INTO custom_wig_orders/.test(sql)) {
        insertCapture.params = params;
        return {
          rows: [{
            id: 99,
            customer_name: params[COL.NAME], customer_phone: params[COL.PHONE], customer_email: params[COL.EMAIL],
            customer_id: params[COL.CUSTOMER_ID],
            circumference_in: params[COL.CIRCUMFERENCE], front_to_nape_in: params[COL.FRONT_TO_NAPE],
            ear_to_ear_forehead_in: params[COL.EAR_TO_EAR_FOREHEAD], ear_to_ear_top_in: params[COL.EAR_TO_EAR_TOP],
            temple_to_temple_in: params[COL.TEMPLE_TO_TEMPLE], nape_of_neck_in: params[COL.NAPE_OF_NECK],
            cap_size: params[COL.CAP_SIZE], lace_style: params[COL.LACE_STYLE],
            style_notes: params[COL.STYLE_NOTES], reference_photo_url: params[COL.PHOTO],
            status: 'new', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }],
        };
      }
      return { rows: [] };
    }
  }
  return { FakePool, calls };
}

function loadHandlerWithMockedPg(insertCapture) {
  const { FakePool, calls } = makeFakePool(insertCapture);
  delete require.cache[PG_PATH];
  delete require.cache[ORDER_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(ORDER_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[ORDER_PATH];
  return { mod, calls };
}

function fakeRequest({ body, cookie } = {}) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : null) },
  };
}
function fakeContext() {
  return { error: () => {}, warn: () => {} };
}

function baseBody(extra) {
  return Object.assign(
    {
      customerName: 'Jamie Customer',
      customerPhone: '(267) 555-0100',
      customerEmail: 'jamie@example.com',
      laceStyle: 'precut',
    },
    extra
  );
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

  // ---------------- validation ----------------

  await test('validateBody: rejects a non-object body', () => {
    const { mod } = loadHandlerWithMockedPg({});
    assert.deepStrictEqual(mod.validateBody(null), ['Request body must be JSON']);
  });

  await test('validateBody: requires customerName/customerPhone/customerEmail', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const errors = mod.validateBody({ laceStyle: 'precut' });
    assert.ok(errors.some((e) => /customerName/.test(e)));
    assert.ok(errors.some((e) => /customerPhone/.test(e)));
    assert.ok(errors.some((e) => /customerEmail/.test(e)));
  });

  await test('validateBody: rejects a malformed email', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const errors = mod.validateBody(baseBody({ customerEmail: 'not-an-email' }));
    assert.ok(errors.some((e) => /customerEmail/.test(e)));
  });

  await test('validateBody: laceStyle is required and must be one of precut/uncut/unsure', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const missing = mod.validateBody(baseBody({ laceStyle: undefined }));
    assert.ok(missing.some((e) => /laceStyle/.test(e)));
    const invalid = mod.validateBody(baseBody({ laceStyle: 'glued' }));
    assert.ok(invalid.some((e) => /laceStyle/.test(e)));
    assert.deepStrictEqual(mod.LACE_STYLES, ['precut', 'uncut', 'unsure']);
  });

  await test('validateBody: capSize, when present, must be one of small/medium/large', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const invalid = mod.validateBody(baseBody({ capSize: 'extra-large' }));
    assert.ok(invalid.some((e) => /capSize/.test(e)));
    const ok = mod.validateBody(baseBody({ capSize: 'medium' }));
    assert.strictEqual(ok.length, 0);
  });

  await test('validateBody: capSize is optional — omitting it entirely is valid', () => {
    const { mod } = loadHandlerWithMockedPg({});
    assert.deepStrictEqual(mod.validateBody(baseBody()), []);
  });

  await test('validateBody: every measurement field is individually optional — none are required', () => {
    const { mod } = loadHandlerWithMockedPg({});
    assert.deepStrictEqual(mod.validateBody(baseBody({ circumferenceIn: 21.5 })), []);
  });

  await test('validateBody: rejects a negative or zero measurement', () => {
    const { mod } = loadHandlerWithMockedPg({});
    for (const [jsonKey] of mod.MEASUREMENT_FIELDS) {
      const negative = mod.validateBody(baseBody({ [jsonKey]: -1 }));
      assert.ok(negative.some((e) => e.includes(jsonKey)), `expected ${jsonKey}=-1 to be rejected`);
      const zero = mod.validateBody(baseBody({ [jsonKey]: 0 }));
      assert.ok(zero.some((e) => e.includes(jsonKey)), `expected ${jsonKey}=0 to be rejected`);
    }
  });

  await test('validateBody: rejects an absurdly large measurement (>40in)', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const errors = mod.validateBody(baseBody({ circumferenceIn: 41 }));
    assert.ok(errors.some((e) => e.includes('circumferenceIn')));
  });

  await test('validateBody: accepts a decimal measurement at the boundary (40.0 in, 0.01 in)', () => {
    const { mod } = loadHandlerWithMockedPg({});
    assert.deepStrictEqual(mod.validateBody(baseBody({ circumferenceIn: 40 })), []);
    assert.deepStrictEqual(mod.validateBody(baseBody({ napeOfNeckIn: 0.01 })), []);
  });

  await test('validateBody: rejects a non-numeric measurement', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const errors = mod.validateBody(baseBody({ circumferenceIn: 'twenty-one' }));
    assert.ok(errors.some((e) => e.includes('circumferenceIn')));
  });

  await test('validateBody: styleNotes must be a string when present', () => {
    const { mod } = loadHandlerWithMockedPg({});
    const errors = mod.validateBody(baseBody({ styleNotes: 12345 }));
    assert.ok(errors.some((e) => /styleNotes/.test(e)));
  });

  await test('validateBody: referencePhotoUrl must point into the configured inspiration-photos container', () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const { mod } = loadHandlerWithMockedPg({});
    assert.deepStrictEqual(mod.validateBody(baseBody({ referencePhotoUrl: VALID_PHOTO_URL })), []);
    const bad = mod.validateBody(baseBody({ referencePhotoUrl: 'https://evil.example.com/x.png' }));
    assert.ok(bad.some((e) => /referencePhotoUrl/.test(e)));
  });

  await test('validateBody: referencePhotoUrl is rejected (fails closed) when the blob endpoint is unconfigured', () => {
    delete process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT;
    const { mod } = loadHandlerWithMockedPg({});
    const errors = mod.validateBody(baseBody({ referencePhotoUrl: VALID_PHOTO_URL }));
    assert.ok(errors.some((e) => /referencePhotoUrl/.test(e)));
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT; // restore for later tests
  });

  await test('POST handler: 400 with details array when validation fails', async () => {
    const { mod } = loadHandlerWithMockedPg({});
    const res = await mod.customWigOrderHandler(fakeRequest({ body: { laceStyle: 'bogus' } }), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.ok(Array.isArray(res.jsonBody.details));
    assert.ok(res.jsonBody.details.length > 1);
  });

  await test('POST handler: 400 on an unparseable (non-JSON) body', async () => {
    const { mod } = loadHandlerWithMockedPg({});
    const res = await mod.customWigOrderHandler(fakeRequest({ body: undefined }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  // ---------------- successful creation ----------------

  await test('201: a guest order (no session cookie) — customer_id stays null, phone gets normalized', async () => {
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const res = await mod.customWigOrderHandler(fakeRequest({ body: baseBody() }), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[COL.CUSTOMER_ID], null);
    assert.strictEqual(res.jsonBody.order.customer_id, null);
    // "(267) 555-0100" normalizes to "+12675550100" — see lib/phone.js.
    assert.strictEqual(capture.params[COL.PHONE], '+12675550100');
    assert.strictEqual(res.jsonBody.order.status, 'new');
    assert.strictEqual(res.jsonBody.order.lace_style, 'precut');
  });

  await test('201: a logged-in customer session -> customer_id is attached to the new order', async () => {
    process.env.CUSTOMER_SESSION_SECRET = 'test-customer-secret';
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const cookie = `${SESSION_COOKIE_NAME}=${signCustomerSession(123, 'test-customer-secret')}`;
    const res = await mod.customWigOrderHandler(fakeRequest({ body: baseBody(), cookie }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(capture.params[COL.CUSTOMER_ID], 123);
    assert.strictEqual(res.jsonBody.order.customer_id, 123);
  });

  await test('201: an invalid/tampered session cookie falls back to a guest order, never errors', async () => {
    process.env.CUSTOMER_SESSION_SECRET = 'test-customer-secret';
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const cookie = `${SESSION_COOKIE_NAME}=not-a-real-token`;
    const res = await mod.customWigOrderHandler(fakeRequest({ body: baseBody(), cookie }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(capture.params[COL.CUSTOMER_ID], null);
  });

  await test('201: cap-size-only path (no individual measurements given)', async () => {
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const res = await mod.customWigOrderHandler(
      fakeRequest({ body: baseBody({ capSize: 'medium' }) }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[COL.CAP_SIZE], 'medium');
    assert.strictEqual(capture.params[COL.CIRCUMFERENCE], null);
  });

  await test('201: full precise-measurements path — all six persisted in the right columns', async () => {
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const body = baseBody({
      circumferenceIn: 21.5, frontToNapeIn: 13.25, earToEarForeheadIn: 12,
      earToEarTopIn: 14.5, templeToTempleIn: 11.75, napeOfNeckIn: 4,
    });
    const res = await mod.customWigOrderHandler(fakeRequest({ body }), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[COL.CIRCUMFERENCE], 21.5);
    assert.strictEqual(capture.params[COL.FRONT_TO_NAPE], 13.25);
    assert.strictEqual(capture.params[COL.EAR_TO_EAR_FOREHEAD], 12);
    assert.strictEqual(capture.params[COL.EAR_TO_EAR_TOP], 14.5);
    assert.strictEqual(capture.params[COL.TEMPLE_TO_TEMPLE], 11.75);
    assert.strictEqual(capture.params[COL.NAPE_OF_NECK], 4);
  });

  await test('201: neither measurements nor cap size given — still succeeds (staff follow up)', async () => {
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const res = await mod.customWigOrderHandler(fakeRequest({ body: baseBody() }), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[COL.CAP_SIZE], null);
  });

  await test('201: styleNotes and a valid referencePhotoUrl are persisted', async () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const res = await mod.customWigOrderHandler(
      fakeRequest({ body: baseBody({ styleNotes: '  24in, bone straight, medium density  ', referencePhotoUrl: VALID_PHOTO_URL }) }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
    assert.strictEqual(capture.params[COL.STYLE_NOTES], '24in, bone straight, medium density');
    assert.strictEqual(capture.params[COL.PHOTO], VALID_PHOTO_URL);
  });

  await test('201: an untrusted referencePhotoUrl is rejected with 400, never persisted', async () => {
    process.env.INSPIRATION_PHOTOS_BLOB_ENDPOINT = BLOB_ENDPOINT;
    process.env.INSPIRATION_PHOTOS_CONTAINER = CONTAINER;
    const { mod } = loadHandlerWithMockedPg({});
    const res = await mod.customWigOrderHandler(
      fakeRequest({ body: baseBody({ referencePhotoUrl: 'https://evil.example.com/x.png' }) }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  // ---------------- email-send failure isolation ----------------
  // Same property book.js's own tests cover only implicitly (see test/bookingLinkage.test.js etc.):
  // with no ACS_EMAIL_CONNECTION_STRING configured anywhere in this file, lib/email.js's
  // sendCustomWigOrderConfirmations() logs a warning and returns without throwing — so every 201
  // above already demonstrates the write succeeding independent of email delivery. This test makes
  // that property explicit rather than merely incidental.
  await test('a successful order does not depend on email being configured at all', async () => {
    delete process.env.ACS_EMAIL_CONNECTION_STRING;
    delete process.env.ACS_EMAIL_FROM_ADDRESS;
    delete process.env.BUSINESS_NOTIFY_EMAIL;
    const capture = {};
    const { mod } = loadHandlerWithMockedPg(capture);
    const res = await mod.customWigOrderHandler(fakeRequest({ body: baseBody() }), fakeContext());
    assert.strictEqual(res.status, 201, JSON.stringify(res.jsonBody));
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
