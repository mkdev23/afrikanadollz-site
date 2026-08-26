// Mocked-DB unit tests for src/functions/admin/dashboard.js (GET /api/staffconsole/dashboard). Same
// require-cache-substitution approach as test/adminBillingApi.test.js. Deliberately does NOT try to
// validate real GROUP BY/date_trunc SQL correctness against the fake pool (that's exactly the kind of
// false confidence the task's testing guidance warns against) -- this only checks the HTTP-layer wiring:
// auth gating, that query params reach fetchDashboardMetrics, that every expected query fires, and that
// the shaped result comes back under {metrics}.
//
// Run with: node test/dashboardApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const DASHBOARD_PATH = path.join(__dirname, '..', 'src', 'functions', 'admin', 'dashboard.js');

const { signSession, SESSION_COOKIE_NAME } = require('../lib/adminAuth');

// Returns a plausible row for whichever of fetchDashboardMetrics's ~10 queries `sql` is -- matched on
// distinctive substrings unique to each query's own text (see lib/dashboardMetrics.js). Exercises every
// branch of shapeDashboardMetrics at the HTTP layer without pretending to validate the SQL itself.
function defaultDispatch(sql) {
  if (/FROM billing_entries\s+WHERE created_at.*GROUP BY bucket ORDER BY bucket/s.test(sql)) {
    return { rows: [{ bucket: '2026-08-01', revenue_cents: '10000', count: 2 }] };
  }
  if (/GROUP BY s\.category ORDER BY revenue_cents DESC/.test(sql)) {
    return { rows: [{ category: 'Wigs', revenue_cents: '10000', count: 2 }] };
  }
  if (/GROUP BY s\.id, s\.name, s\.category/.test(sql)) {
    return { rows: [{ service_id: 1, name: 'Full Lace Install', category: 'Wigs', revenue_cents: '10000', count: 2 }] };
  }
  if (/GROUP BY bucket, status ORDER BY bucket/.test(sql)) {
    return { rows: [{ bucket: '2026-08-01', status: 'confirmed', count: 2 }] };
  }
  if (/SELECT status, COUNT\(\*\)::int AS count/.test(sql)) {
    return { rows: [{ status: 'confirmed', count: 2 }, { status: 'completed', count: 5 }] };
  }
  if (/EXTRACT\(DOW FROM start_at/.test(sql)) {
    return { rows: [{ weekday: 2, count: 3 }] };
  }
  if (/no_show_count/.test(sql)) {
    return { rows: [{ category: 'Wigs', no_show_count: 0, total: 7 }] };
  }
  if (/WITH first_appt AS/.test(sql)) {
    return { rows: [{ new_customers: 1, returning_customers: 4 }] };
  }
  if (/total_cents/.test(sql)) {
    return { rows: [{ total_cents: '10000', count: 2 }] };
  }
  if (/next_7_days/.test(sql)) {
    return { rows: [{ next_7_days: 1, next_30_days: 3 }] };
  }
  throw new Error('unmatched SQL in test fake pool: ' + sql);
}

function makeFakePool(queryImpl) {
  const calls = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      if (/^SELECT session_epoch FROM admin_account WHERE id = 1$/.test(sql)) {
        return { rows: [{ session_epoch: 1 }] };
      }
      calls.push({ sql, params });
      return (queryImpl || defaultDispatch)(sql, params, calls.length - 1);
    }
  }
  return { FakePool, calls };
}

function loadHandlerWithMockedPg(queryImpl) {
  const { FakePool, calls } = makeFakePool(queryImpl);
  delete require.cache[PG_PATH];
  delete require.cache[DASHBOARD_PATH];
  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  const mod = require(DASHBOARD_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[DASHBOARD_PATH];
  return { mod, calls };
}

function fakeRequest({ query, cookie } = {}) {
  const q = new Map(Object.entries(query || {}));
  return {
    params: {},
    query: { get: (name) => (q.has(name) ? q.get(name) : null) },
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

  await test('401 without admin auth', async () => {
    const { mod } = loadHandlerWithMockedPg();
    const res = await mod.adminDashboardHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('200 returns a metrics object shaped by fetchDashboardMetrics, using the requested `days`', async () => {
    const { mod, calls } = loadHandlerWithMockedPg();
    const res = await mod.adminDashboardHandler(fakeRequest({ cookie: COOKIE, query: { days: '30' } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.ok(res.jsonBody.metrics, 'no metrics in response');
    assert.strictEqual(res.jsonBody.metrics.range.days, 30);
    assert.strictEqual(res.jsonBody.metrics.range.granularity, 'day');
    assert.deepStrictEqual(res.jsonBody.metrics.revenueByCategory, [{ category: 'Wigs', revenueCents: 10000, count: 2 }]);
    // Every one of fetchDashboardMetrics's aggregation queries actually fired (10, plus the
    // intercepted session_epoch check is excluded from `calls`).
    assert.strictEqual(calls.length, 10, `expected 10 queries, saw ${calls.length}`);
  });

  await test('200 honors explicit from/to over `days`', async () => {
    const { mod } = loadHandlerWithMockedPg();
    const res = await mod.adminDashboardHandler(
      fakeRequest({ cookie: COOKIE, query: { from: '2026-01-01', to: '2026-01-31' } }),
      fakeContext()
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.metrics.range.from, '2026-01-01');
    assert.strictEqual(res.jsonBody.metrics.range.to, '2026-01-31');
  });

  await test('500 when a query throws, and the error is logged via context.error', async () => {
    const { mod } = loadHandlerWithMockedPg(() => { throw new Error('db exploded'); });
    let loggedErr = null;
    const ctx = { error: (...args) => { loggedErr = args; }, warn: () => {} };
    const res = await mod.adminDashboardHandler(fakeRequest({ cookie: COOKIE }), ctx);
    assert.strictEqual(res.status, 500);
    assert.ok(loggedErr, 'context.error was not called');
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
