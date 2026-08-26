// Mocked-DB unit tests for src/functions/admin/clients.js (the Clients/client-notes staffconsole
// endpoints). Same require-cache-substitution approach as test/adminApi.test.js and
// test/adminBillingApi.test.js, and reuses their `signSession`/requireAdmin machinery for real
// (lib/adminAuth.js is pure crypto, not mocked).
//
// Run with: node test/adminClientsApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const CLIENTS_PATH = path.join(__dirname, '..', 'src', 'functions', 'admin', 'clients.js');

const { signSession, SESSION_COOKIE_NAME } = require('../lib/adminAuth');

// requireAdmin() now looks up admin_account's current session_epoch on every call (see
// lib/adminAuth.js's header comment / db/schema.sql's admin_account.session_epoch comment) --
// answered here from a fixed epoch of 1 (matching signSession(secret, 1) below) so none of this
// file's existing tests need to know that query exists. It's intercepted before reaching the test's
// own queryImpl / `calls`, same approach as test/adminApi.test.js's makeFakePool.
function makeFakePool(queryImpl) {
  const calls = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      if (/^SELECT session_epoch FROM admin_account WHERE id = 1$/.test(sql)) {
        return { rows: [{ session_epoch: 1 }] };
      }
      calls.push({ sql, params });
      return queryImpl(sql, params, calls.length - 1);
    }
  }
  return { FakePool, calls };
}

function loadHandlerWithMockedPg(queryImpl) {
  const { FakePool, calls } = makeFakePool(queryImpl);
  delete require.cache[PG_PATH];
  delete require.cache[CLIENTS_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(CLIENTS_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[CLIENTS_PATH];
  return { mod, calls };
}

function fakeRequest({ body, params, query, cookie } = {}) {
  const q = query || {};
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    params: params || {},
    query: { get: (name) => (Object.prototype.hasOwnProperty.call(q, name) ? q[name] : null) },
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : null) },
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

  process.env.ADMIN_SESSION_SECRET = 'test-secret';
  const COOKIE = `${SESSION_COOKIE_NAME}=${signSession('test-secret', 1)}`;

  // ---------------- list / search ----------------

  await test('list: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientsListHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('list: 200 with no search returns all customers, no WHERE clause', async () => {
    const rows = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Ben' }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminClientsListHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customers, rows);
    assert.ok(!/WHERE/.test(calls[0].sql));
  });

  await test('list: 200 with search applies ILIKE across name/email/phone', async () => {
    const rows = [{ id: 1, name: 'Ada Ade' }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminClientsListHandler(fakeRequest({ cookie: COOKIE, query: { search: 'ada' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customers, rows);
    assert.ok(/ILIKE/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['%ada%']);
  });

  // Added alongside lib/phone.js's phone-normalization pass: phone numbers are stored however they
  // were typed at write time (see lib/phone.js's header comment), so a plain ILIKE against the raw
  // `phone` column misses a match whenever staff searches in a different shape than what's stored.
  // These cases exercise the digit-insensitive comparison added for that (regexp_replace on both
  // sides, only when the search term itself looks phone-ish).

  await test('list: search: a differently-formatted phone search still matches a stored number in another format (digit-insensitive)', async () => {
    const rows = [{ id: 3, name: 'Jamie Rivera', phone: '+12674814058' }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminClientsListHandler(
      fakeRequest({ cookie: COOKIE, query: { search: '(267) 481-4058' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customers, rows);
    assert.ok(/regexp_replace\(COALESCE\(phone, ''\)/.test(calls[0].sql), 'expected a digit-insensitive phone comparison in the query');
    assert.ok(/name ILIKE \$1 OR email ILIKE \$1/.test(calls[0].sql), 'name/email matching must be left exactly as-is');
    assert.deepStrictEqual(calls[0].params, ['%(267) 481-4058%', '2674814058']);
  });

  await test('list: search: a bare-digits phone search also triggers the digit-insensitive phone comparison', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    await mod.adminClientsListHandler(fakeRequest({ cookie: COOKIE, query: { search: '2674814058' } }), fakeContext());
    assert.ok(/regexp_replace\(COALESCE\(phone, ''\)/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['%2674814058%', '2674814058']);
  });

  // Added when it turned out customers.phone is virtually always NULL in practice — it's only ever
  // populated by an SMS/OTP sign-in, and every real customer so far signed up by email. A phone
  // number given at booking time lives on appointments.customer_phone instead, so search must also
  // check that (scoped to appointments already linked to the customer, via an EXISTS subquery).
  await test('list: search: a phone search also matches via a linked appointment\'s customer_phone (customers.phone stays NULL)', async () => {
    const rows = [{ id: 6, name: 'Vafa farr', phone: null }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminClientsListHandler(
      fakeRequest({ cookie: COOKIE, query: { search: '(610) 742-8986' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customers, rows);
    assert.ok(/EXISTS \(/.test(calls[0].sql), 'expected an EXISTS subquery against appointments');
    assert.ok(/FROM appointments a/.test(calls[0].sql));
    assert.ok(/a\.customer_id = customers\.id/.test(calls[0].sql), 'must scope to appointments already linked to this customer');
    assert.ok(/regexp_replace\(COALESCE\(a\.customer_phone, ''\)/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['%(610) 742-8986%', '6107428986']);
  });

  await test('list: search: a pure-letters name search does not add the phone clause and does not strip anything', async () => {
    const rows = [{ id: 4, name: 'Jasmine' }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminClientsListHandler(fakeRequest({ cookie: COOKIE, query: { search: 'Jasmine' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customers, rows);
    assert.ok(!/regexp_replace/.test(calls[0].sql), 'a digit-less search must not trigger the phone comparison at all');
    assert.deepStrictEqual(calls[0].params, ['%Jasmine%']);
  });

  await test('list: search: an email search is unaffected (no digits, no phone clause, plain ILIKE)', async () => {
    const rows = [{ id: 5, email: 'jamie@example.com' }];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminClientsListHandler(
      fakeRequest({ cookie: COOKIE, query: { search: 'jamie@example.com' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customers, rows);
    assert.ok(!/regexp_replace/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['%jamie@example.com%']);
  });

  // ---------------- detail ----------------

  await test('detail: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientDetailHandler(fakeRequest({ params: { id: '5' } }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('detail: 400 on a non-integer id', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientDetailHandler(fakeRequest({ cookie: COOKIE, params: { id: 'abc' } }), fakeContext());
    assert.strictEqual(res.status, 400);
  });

  await test('detail: 404 when the customer does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientDetailHandler(fakeRequest({ cookie: COOKIE, params: { id: '999' } }), fakeContext());
    assert.strictEqual(res.status, 404);
  });

  await test('detail: 200 returns customer + appointments (newest first) + notes (newest first)', async () => {
    const customer = { id: 5, name: 'Cee', email: 'c@e.com', phone: '555', hair_type: 'natural', hair_texture: '4c', allergies: null, preferences: 'no heat' };
    const appts = [{ id: 20, start_at: '2026-08-01T00:00:00Z' }, { id: 10, start_at: '2026-07-01T00:00:00Z' }];
    const notes = [{ id: 2, note: 'newer' }, { id: 1, note: 'older' }];
    const { mod, calls } = loadHandlerWithMockedPg(async (sql) => {
      if (/FROM customers WHERE id/.test(sql)) return { rows: [customer] };
      if (/FROM appointments a/.test(sql)) return { rows: appts };
      if (/FROM client_notes/.test(sql)) return { rows: notes };
      return { rows: [] };
    });
    const res = await mod.adminClientDetailHandler(fakeRequest({ cookie: COOKIE, params: { id: '5' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.customer, customer);
    assert.deepStrictEqual(res.jsonBody.appointments, appts);
    assert.deepStrictEqual(res.jsonBody.notes, notes);
    const apptCall = calls.find((c) => /FROM appointments a/.test(c.sql));
    assert.ok(/ORDER BY a.start_at DESC/.test(apptCall.sql));
    const notesCall = calls.find((c) => /FROM client_notes/.test(c.sql));
    assert.ok(/ORDER BY created_at DESC/.test(notesCall.sql));
  });

  // ---------------- update profile ----------------

  await test('update: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ params: { id: '5' }, body: { hair_type: 'natural' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('update: 400 on a non-integer id', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: 'abc' }, body: { hair_type: 'natural' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 400 when body has none of the recognized profile fields', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { unrelated: 'x' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 404 when the customer does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' }, body: { hair_type: 'locs' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('update: 200 does a partial patch — only provided fields are set', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async (sql, params) => ({
      rows: [{ id: 5, name: 'Cee', email: 'c@e.com', phone: '555', hair_type: params[0], hair_texture: null, allergies: null, preferences: null }],
    }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { hair_type: '  natural  ' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.customer.hair_type, 'natural');
    assert.deepStrictEqual(calls[0].params, ['natural', '5']);
    assert.ok(/SET hair_type = \$1 WHERE/.test(calls[0].sql));
  });

  await test('update: an explicit null clears a field', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({
      rows: [{ id: 5, allergies: null }],
    }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { allergies: null } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls[0].params, [null, '5']);
  });

  await test('update: multiple fields at once builds a multi-column SET', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows: [{ id: 5 }] }));
    const res = await mod.adminClientUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { hair_type: 'relaxed', preferences: 'low heat', ignored: 'x' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls[0].params, ['relaxed', 'low heat', '5']);
    assert.ok(/SET hair_type = \$1, preferences = \$2/.test(calls[0].sql));
  });

  // ---------------- add note ----------------

  await test('note create: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientNoteCreateHandler(
      fakeRequest({ params: { id: '5' }, body: { note: 'hi' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('note create: 400 on empty/missing note', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const missing = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: {} }),
      fakeContext()
    );
    assert.strictEqual(missing.status, 400);

    const blank = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { note: '   ' } }),
      fakeContext()
    );
    assert.strictEqual(blank.status, 400);
  });

  await test('note create: 400 on a non-integer appointmentId', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { note: 'hi', appointmentId: 'abc' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('note create: 404 when the customer does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async (sql) => {
      if (/SELECT id FROM customers/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' }, body: { note: 'hi' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('note create: 400 when appointmentId does not belong to this customer', async () => {
    const { mod } = loadHandlerWithMockedPg(async (sql) => {
      if (/SELECT id FROM customers/.test(sql)) return { rows: [{ id: 5 }] };
      if (/SELECT id FROM appointments WHERE id = \$1 AND customer_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { note: 'hi', appointmentId: '77' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('note create: 201 inserts with created_by=admin, appointment_id null when omitted', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async (sql, params) => {
      if (/SELECT id FROM customers/.test(sql)) return { rows: [{ id: 5 }] };
      if (/INSERT INTO client_notes/.test(sql)) {
        return {
          rows: [{
            id: 1, customer_id: params[0], appointment_id: params[1], note: params[2],
            created_by: 'admin', created_at: 'now',
          }],
        };
      }
      return { rows: [] };
    });
    const res = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { note: '  Great first visit, loves loose curls  ' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.jsonBody.note.created_by, 'admin');
    assert.strictEqual(res.jsonBody.note.appointment_id, null);
    const insertCall = calls.find((c) => /INSERT INTO client_notes/.test(c.sql));
    assert.deepStrictEqual(insertCall.params, ['5', null, 'Great first visit, loves loose curls']);
  });

  await test('note create: 201 with a valid appointmentId links the note to that visit', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async (sql, params) => {
      if (/SELECT id FROM customers/.test(sql)) return { rows: [{ id: 5 }] };
      if (/SELECT id FROM appointments WHERE id = \$1 AND customer_id/.test(sql)) return { rows: [{ id: 77 }] };
      if (/INSERT INTO client_notes/.test(sql)) {
        return {
          rows: [{ id: 2, customer_id: params[0], appointment_id: params[1], note: params[2], created_by: 'admin', created_at: 'now' }],
        };
      }
      return { rows: [] };
    });
    const res = await mod.adminClientNoteCreateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { note: 'Allergic to a bonding glue', appointmentId: '77' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.jsonBody.note.appointment_id, '77');
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
