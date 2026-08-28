// Mocked-DB unit tests for src/functions/admin/customOrders.js (the staffconsole custom-wig-order
// endpoints). Same require-cache-substitution approach as test/adminClientsApi.test.js, and reuses
// its `signSession`/requireAdmin machinery for real (lib/adminAuth.js is pure crypto, not mocked).
//
// Run with: node test/adminCustomOrdersApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const ORDERS_PATH = path.join(__dirname, '..', 'src', 'functions', 'admin', 'customOrders.js');

const { signSession, SESSION_COOKIE_NAME } = require('../lib/adminAuth');

// requireAdmin() looks up admin_account's current session_epoch on every call — answered here from a
// fixed epoch of 1 (matching signSession(secret, 1) below), same as test/adminClientsApi.test.js.
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
  delete require.cache[ORDERS_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;
  const mod = require(ORDERS_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[ORDERS_PATH];
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

const SAMPLE_ORDER = {
  id: 5, customer_name: 'Ada', customer_phone: '+12675550100', customer_email: 'ada@example.com',
  customer_id: null, circumference_in: '21.50', front_to_nape_in: null, ear_to_ear_forehead_in: null,
  ear_to_ear_top_in: null, temple_to_temple_in: null, nape_of_neck_in: null, cap_size: null,
  lace_style: 'precut', style_notes: null, reference_photo_url: null, status: 'new',
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

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

  // ---------------- list ----------------

  await test('list: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrdersListHandler(fakeRequest(), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('list: 200 with no status filter returns all orders, newest first, no WHERE clause', async () => {
    const rows = [SAMPLE_ORDER];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminCustomOrdersListHandler(fakeRequest({ cookie: COOKIE }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.orders, rows);
    assert.ok(!/WHERE/.test(calls[0].sql));
    assert.ok(/ORDER BY created_at DESC/.test(calls[0].sql));
  });

  await test('list: 400 on an invalid status filter', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrdersListHandler(
      fakeRequest({ cookie: COOKIE, query: { status: 'bogus' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('list: 200 with a valid status filter applies WHERE status = $1', async () => {
    const rows = [SAMPLE_ORDER];
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows }));
    const res = await mod.adminCustomOrdersListHandler(
      fakeRequest({ cookie: COOKIE, query: { status: 'in_progress' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.ok(/WHERE status = \$1/.test(calls[0].sql));
    assert.deepStrictEqual(calls[0].params, ['in_progress']);
  });

  // ---------------- detail ----------------

  await test('detail: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderDetailHandler(fakeRequest({ params: { id: '5' } }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('detail: 400 on a non-integer id', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderDetailHandler(
      fakeRequest({ cookie: COOKIE, params: { id: 'abc' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('detail: 404 when the order does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderDetailHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('detail: 200 returns the full order row', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [SAMPLE_ORDER] }));
    const res = await mod.adminCustomOrderDetailHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.order, SAMPLE_ORDER);
  });

  // ---------------- update (PATCH) ----------------

  await test('update: 401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ params: { id: '5' }, body: { status: 'ready' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 401);
  });

  await test('update: 400 on a non-integer id', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: 'abc' }, body: { status: 'ready' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 400 when the body has no recognized fields', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { unrelated: 'x' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 400 on an invalid status value', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { status: 'bogus' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 400 on an invalid capSize value', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { capSize: 'huge' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 400 on an out-of-bounds measurement', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { circumferenceIn: 100 } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 400);
  });

  await test('update: 404 when the order does not exist', async () => {
    const { mod } = loadHandlerWithMockedPg(async () => ({ rows: [] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '999' }, body: { status: 'ready' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 404);
  });

  await test('update: 200 does a partial patch — status alone bumps updated_at, other fields untouched', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async (sql, params) => ({
      rows: [Object.assign({}, SAMPLE_ORDER, { status: params[0] })],
    }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { status: 'in_progress' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.order.status, 'in_progress');
    assert.deepStrictEqual(calls[0].params, ['in_progress', '5']);
    assert.ok(/SET status = \$1, updated_at = now\(\) WHERE/.test(calls[0].sql));
  });

  await test('update: 200 staff can correct measurements and style notes in the same patch', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows: [SAMPLE_ORDER] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({
        cookie: COOKIE,
        params: { id: '5' },
        body: { circumferenceIn: 22, styleNotes: '  Called customer, confirmed bone-straight 24in  ' },
      }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls[0].params, [22, 'Called customer, confirmed bone-straight 24in', '5']);
    assert.ok(/SET circumference_in = \$1, style_notes = \$2/.test(calls[0].sql));
  });

  await test('update: an explicit null clears capSize and a measurement', async () => {
    const { mod, calls } = loadHandlerWithMockedPg(async () => ({ rows: [SAMPLE_ORDER] }));
    const res = await mod.adminCustomOrderUpdateHandler(
      fakeRequest({ cookie: COOKIE, params: { id: '5' }, body: { capSize: null, circumferenceIn: null } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls[0].params, [null, null, '5']);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
