// Mocked-DB unit tests for src/functions/admin/dashboardInsights.js (POST
// /api/staffconsole/dashboard/insights). Same require-cache-substitution approach as
// test/adminBillingApi.test.js, extended to also substitute lib/openai.js (so a "regenerate" never
// makes a real network call) the same way test/adminBillingApi.test.js substitutes lib/stripe.js for
// its pay-link tests.
//
// Covers exactly the behaviors the task's cost-design hinges on:
//   - a normal (non-regenerate) request NEVER touches lib/openai.js -- verified by making the mocked
//     generateInsights throw if it's ever called on that path;
//   - cache-hit reads back out of the `settings` table with the right staleness flag;
//   - `regenerate: true` is rate-limited via lib/rateLimit.js's real rate_limit_events-counting logic
//     (not re-mocked -- enforceRateLimit is exercised for real against the fake pool's rate_limit_events
//     query responses, same as test/styleSuggest.test.js's approach elsewhere in this codebase);
//   - a successful regeneration stores {insights, generatedAt, metricsRange} back into `settings` via
//     the same upsert shape src/functions/admin/settings.js uses.
//
// Run with: node test/dashboardInsightsApi.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const PG_PATH = require.resolve('pg');
const OPENAI_LIB_PATH = path.join(__dirname, '..', 'lib', 'openai.js');
const INSIGHTS_PATH = path.join(__dirname, '..', 'src', 'functions', 'admin', 'dashboardInsights.js');

const { signSession, SESSION_COOKIE_NAME } = require('../lib/adminAuth');

// Read the real REGENERATE_RATE_LIMIT constant once, from a normal (unmocked) require, before any
// require-cache substitution happens below -- so the rate-limit test exercises the module's actual
// configured threshold rather than a hardcoded guess at it.
const { REGENERATE_RATE_LIMIT } = require(INSIGHTS_PATH);
delete require.cache[INSIGHTS_PATH];

// Same fetchDashboardMetrics-query dispatcher as test/dashboardApi.test.js, reused here so a
// `regenerate: true` request's internal metrics fetch has something valid to work with.
function metricsDispatch(sql) {
  if (/FROM billing_entries\s+WHERE created_at.*GROUP BY bucket ORDER BY bucket/s.test(sql)) return { rows: [] };
  if (/GROUP BY s\.category ORDER BY revenue_cents DESC/.test(sql)) return { rows: [{ category: 'Wigs', revenue_cents: '10000', count: 2 }] };
  if (/GROUP BY s\.id, s\.name, s\.category/.test(sql)) return { rows: [] };
  if (/GROUP BY bucket, status ORDER BY bucket/.test(sql)) return { rows: [] };
  if (/SELECT status, COUNT\(\*\)::int AS count/.test(sql)) return { rows: [{ status: 'confirmed', count: 2 }] };
  if (/EXTRACT\(DOW FROM start_at/.test(sql)) return { rows: [] };
  if (/no_show_count/.test(sql)) return { rows: [] };
  if (/WITH first_appt AS/.test(sql)) return { rows: [{ new_customers: 1, returning_customers: 1 }] };
  if (/total_cents/.test(sql)) return { rows: [{ total_cents: '10000', count: 2 }] };
  if (/next_7_days/.test(sql)) return { rows: [{ next_7_days: 1, next_30_days: 2 }] };
  return null; // not a metrics query -- caller handles settings/rate_limit_events itself
}

// `settingsRow` seeds what a SELECT ... FROM settings WHERE key = $1 returns (or none, for "never
// generated"). `rateLimitCount` seeds what enforceRateLimit's COUNT(*) sees for the regenerate bucket,
// so the real (unmocked) lib/rateLimit.js logic can be exercised against a fake pool, same technique
// this codebase already uses for its other rate-limited endpoints.
function makeFakePool({ settingsRow, rateLimitCount = 0 } = {}) {
  const calls = [];
  const inserts = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      if (/^SELECT session_epoch FROM admin_account WHERE id = 1$/.test(sql)) {
        return { rows: [{ session_epoch: 1 }] };
      }
      calls.push({ sql, params });

      if (/FROM rate_limit_events/.test(sql)) {
        return { rows: [{ count: rateLimitCount }] };
      }
      if (/INSERT INTO rate_limit_events/.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT value, updated_at FROM settings WHERE key = \$1/.test(sql)) {
        return { rows: settingsRow ? [settingsRow] : [] };
      }
      if (/INSERT INTO settings/.test(sql)) {
        inserts.push({ sql, params });
        return { rows: [] };
      }
      const metricsResult = metricsDispatch(sql);
      if (metricsResult) return metricsResult;
      throw new Error('unmatched SQL in test fake pool: ' + sql);
    }
  }
  return { FakePool, calls, inserts };
}

function loadHandlerWithMocks({ settingsRow, rateLimitCount, openaiMock } = {}) {
  const { FakePool, calls, inserts } = makeFakePool({ settingsRow, rateLimitCount });
  delete require.cache[PG_PATH];
  delete require.cache[OPENAI_LIB_PATH];
  delete require.cache[INSIGHTS_PATH];

  const fakePg = new Module(PG_PATH);
  fakePg.exports = { Pool: FakePool };
  fakePg.loaded = true;
  require.cache[PG_PATH] = fakePg;

  const fakeOpenai = new Module(OPENAI_LIB_PATH);
  fakeOpenai.exports = openaiMock || {
    generateInsights: async () => { throw new Error('generateInsights should not be called on this path'); },
  };
  fakeOpenai.loaded = true;
  require.cache[OPENAI_LIB_PATH] = fakeOpenai;

  const mod = require(INSIGHTS_PATH);
  delete require.cache[PG_PATH];
  delete require.cache[OPENAI_LIB_PATH];
  delete require.cache[INSIGHTS_PATH];
  return { mod, calls, inserts };
}

function fakeRequest({ body, cookie } = {}) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    params: {},
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie || '' : name.toLowerCase() === 'x-forwarded-for' ? '1.2.3.4' : null) },
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
    const { mod } = loadHandlerWithMocks({});
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ body: {} }), fakeContext());
    assert.strictEqual(res.status, 401);
  });

  await test('normal request with no cache yet: 200, empty insights, cached:false, and generateInsights is never called', async () => {
    const { mod, calls } = loadHandlerWithMocks({ settingsRow: undefined });
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ cookie: COOKIE, body: {} }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.cached, false);
    assert.deepStrictEqual(res.jsonBody.insights, []);
    assert.strictEqual(res.jsonBody.generatedAt, null);
    // Only the settings SELECT should have run -- no rate-limit or metrics queries on this path.
    assert.strictEqual(calls.length, 1);
    assert.ok(/SELECT value, updated_at FROM settings/.test(calls[0].sql));
  });

  await test('normal request with a fresh cached entry: 200, cached:true, stale:false, never calls generateInsights', async () => {
    const generatedAt = new Date().toISOString(); // just now -- well within STALE_MS
    const { mod } = loadHandlerWithMocks({
      settingsRow: { value: { insights: [{ title: 'T', detail: 'D' }], generatedAt, metricsRange: { from: 'a', to: 'b' } }, updated_at: generatedAt },
    });
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ cookie: COOKIE, body: {} }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.cached, true);
    assert.strictEqual(res.jsonBody.stale, false);
    assert.deepStrictEqual(res.jsonBody.insights, [{ title: 'T', detail: 'D' }]);
  });

  await test('normal request with a stale (>24h old) cached entry: cached:true but stale:true, still no generateInsights call', async () => {
    const generatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const { mod } = loadHandlerWithMocks({
      settingsRow: { value: { insights: [{ title: 'T', detail: 'D' }], generatedAt, metricsRange: null }, updated_at: generatedAt },
    });
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ cookie: COOKIE, body: {} }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.cached, true);
    assert.strictEqual(res.jsonBody.stale, true);
  });

  await test('regenerate:true: calls generateInsights with the fetched metrics, then stores insights+generatedAt+metricsRange into settings', async () => {
    let capturedMetrics = null;
    const openaiMock = {
      generateInsights: async ({ metrics }) => {
        capturedMetrics = metrics;
        return [{ title: 'Braids no-shows are high', detail: 'Cite a real number here.' }];
      },
    };
    const { mod, inserts } = loadHandlerWithMocks({ rateLimitCount: 0, openaiMock });
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ cookie: COOKIE, body: { regenerate: true } }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.jsonBody.cached, false);
    assert.strictEqual(res.jsonBody.stale, false);
    assert.deepStrictEqual(res.jsonBody.insights, [{ title: 'Braids no-shows are high', detail: 'Cite a real number here.' }]);
    assert.ok(res.jsonBody.generatedAt, 'no generatedAt in response');
    assert.ok(capturedMetrics && capturedMetrics.range, 'generateInsights was not given a real metrics snapshot');

    assert.strictEqual(inserts.length, 1, 'expected exactly one settings upsert');
    const storedValue = JSON.parse(inserts[0].params[1]);
    assert.deepStrictEqual(storedValue.insights, [{ title: 'Braids no-shows are high', detail: 'Cite a real number here.' }]);
    assert.ok(storedValue.generatedAt);
    assert.ok(storedValue.metricsRange, 'metrics snapshot range was not stored alongside the insights');
    assert.strictEqual(inserts[0].params[0], mod.SETTINGS_KEY);
  });

  await test('regenerate:true is rate-limited (429) once the configured threshold is hit, and never calls generateInsights', async () => {
    const openaiMock = { generateInsights: async () => { throw new Error('should not be called once rate-limited'); } };
    const { mod } = loadHandlerWithMocks({ rateLimitCount: REGENERATE_RATE_LIMIT.maxAttempts, openaiMock });
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ cookie: COOKIE, body: { regenerate: true } }), fakeContext());
    assert.strictEqual(res.status, 429);
    assert.ok(res.jsonBody.error);
    assert.ok(res.headers && res.headers['Retry-After'], 'missing Retry-After header');
  });

  await test('regenerate:true is allowed one attempt short of the threshold', async () => {
    const openaiMock = { generateInsights: async () => [{ title: 'T', detail: 'D' }] };
    const { mod } = loadHandlerWithMocks({ rateLimitCount: REGENERATE_RATE_LIMIT.maxAttempts - 1, openaiMock });
    const res = await mod.adminDashboardInsightsHandler(fakeRequest({ cookie: COOKIE, body: { regenerate: true } }), fakeContext());
    assert.strictEqual(res.status, 200);
  });

  await test('shapeCachedResponse: exported helper reflects a null row as "never generated"', () => {
    const { mod } = loadHandlerWithMocks({});
    const shaped = mod.shapeCachedResponse(undefined, new Date());
    assert.deepStrictEqual(shaped, { cached: false, insights: [], generatedAt: null, stale: true, metricsRange: null });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
