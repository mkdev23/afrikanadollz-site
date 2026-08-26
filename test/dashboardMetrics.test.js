// Unit tests for lib/dashboardMetrics.js's pure (non-DB) pieces: resolveDateRange, pickGranularity,
// addDaysYmd, and shapeDashboardMetrics. Deliberately does NOT try to test fetchDashboardMetrics's real
// SQL aggregation against a mocked pg.query -- a mock can't validate GROUP BY/date_trunc correctness,
// it would only prove the mock returns whatever the mock was told to return. Per the task's testing
// guidance, only the pure "shape metrics into a response" logic is unit-tested here; HTTP-handler-level
// wiring (auth gating, route params, caching) is covered separately in test/dashboardApi.test.js and
// test/dashboardInsightsApi.test.js using this codebase's require-cache-substitution pattern.
//
// Run with: node test/dashboardMetrics.test.js
'use strict';

const assert = require('assert');
const {
  resolveDateRange,
  pickGranularity,
  shapeDashboardMetrics,
  addDaysYmd,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  DAILY_GRANULARITY_MAX_DAYS,
  TIMEZONE,
} = require('../lib/dashboardMetrics');
const { zonedWallTimeToUtc } = require('../lib/availability');

async function run() {
  let passed = 0;
  const test = (name, fn) => {
    try {
      fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  // ---------------- addDaysYmd ----------------

  test('addDaysYmd: adds across a month boundary', () => {
    assert.strictEqual(addDaysYmd('2026-01-31', 1), '2026-02-01');
  });
  test('addDaysYmd: subtracts into a shorter month (non-leap Feb)', () => {
    assert.strictEqual(addDaysYmd('2026-03-01', -1), '2026-02-28');
  });
  test('addDaysYmd: n=0 is a no-op', () => {
    assert.strictEqual(addDaysYmd('2026-06-15', 0), '2026-06-15');
  });

  // ---------------- pickGranularity ----------------

  test(`pickGranularity: <= ${DAILY_GRANULARITY_MAX_DAYS} days is "day"`, () => {
    assert.strictEqual(pickGranularity(1), 'day');
    assert.strictEqual(pickGranularity(DAILY_GRANULARITY_MAX_DAYS), 'day');
  });
  test(`pickGranularity: > ${DAILY_GRANULARITY_MAX_DAYS} days is "week"`, () => {
    assert.strictEqual(pickGranularity(DAILY_GRANULARITY_MAX_DAYS + 1), 'week');
    assert.strictEqual(pickGranularity(365), 'week');
  });

  // ---------------- resolveDateRange ----------------

  const NOW = new Date('2026-08-19T15:00:00Z'); // a Wednesday afternoon UTC

  test('resolveDateRange: defaults to the last DEFAULT_RANGE_DAYS days ending today, with no query params', () => {
    const r = resolveDateRange({}, NOW);
    assert.strictEqual(r.toYmd, '2026-08-19');
    assert.strictEqual(r.days, DEFAULT_RANGE_DAYS);
    assert.strictEqual(addDaysYmd(r.fromYmd, DEFAULT_RANGE_DAYS - 1), r.toYmd);
  });

  test('resolveDateRange: explicit from+to wins outright', () => {
    const r = resolveDateRange({ from: '2026-01-01', to: '2026-01-10' }, NOW);
    assert.strictEqual(r.fromYmd, '2026-01-01');
    assert.strictEqual(r.toYmd, '2026-01-10');
    assert.strictEqual(r.days, 10);
  });

  test('resolveDateRange: `days` shortcut is honored when from/to are absent', () => {
    const r = resolveDateRange({ days: '30' }, NOW);
    assert.strictEqual(r.toYmd, '2026-08-19');
    assert.strictEqual(r.days, 30);
    assert.strictEqual(r.fromYmd, '2026-07-21');
  });

  test('resolveDateRange: a non-numeric/zero/negative `days` falls back to the default', () => {
    assert.strictEqual(resolveDateRange({ days: 'nope' }, NOW).days, DEFAULT_RANGE_DAYS);
    assert.strictEqual(resolveDateRange({ days: '0' }, NOW).days, DEFAULT_RANGE_DAYS);
    assert.strictEqual(resolveDateRange({ days: '-5' }, NOW).days, DEFAULT_RANGE_DAYS);
  });

  test('resolveDateRange: an inverted explicit from>to range is swapped, not rejected', () => {
    const r = resolveDateRange({ from: '2026-02-10', to: '2026-02-01' }, NOW);
    assert.strictEqual(r.fromYmd, '2026-02-01');
    assert.strictEqual(r.toYmd, '2026-02-10');
  });

  test('resolveDateRange: a too-wide explicit range is clamped to MAX_RANGE_DAYS, keeping `to` fixed', () => {
    const r = resolveDateRange({ from: '2000-01-01', to: '2026-08-19' }, NOW);
    assert.strictEqual(r.toYmd, '2026-08-19');
    assert.strictEqual(r.days, MAX_RANGE_DAYS);
  });

  test('resolveDateRange: `days` larger than MAX_RANGE_DAYS is clamped', () => {
    const r = resolveDateRange({ days: '9999' }, NOW);
    assert.strictEqual(r.days, MAX_RANGE_DAYS);
  });

  test('resolveDateRange: `to` is the exclusive UTC instant for local midnight the day AFTER toYmd', () => {
    const r = resolveDateRange({ from: '2026-03-01', to: '2026-03-05' }, NOW);
    const expected = zonedWallTimeToUtc(2026, 3, 6, 0, 0, TIMEZONE);
    assert.strictEqual(r.to.getTime(), expected.getTime());
    const expectedFrom = zonedWallTimeToUtc(2026, 3, 1, 0, 0, TIMEZONE);
    assert.strictEqual(r.from.getTime(), expectedFrom.getTime());
  });

  // ---------------- shapeDashboardMetrics ----------------

  test('shapeDashboardMetrics: maps revenue/booking rows, using bucket dates as-is', () => {
    const out = shapeDashboardMetrics({
      range: { fromYmd: '2026-07-01', toYmd: '2026-07-31', days: 31 },
      granularity: 'day',
      revenueOverTimeRows: [
        { bucket: new Date('2026-07-01T00:00:00Z'), revenue_cents: '5000', count: 2 },
        { bucket: '2026-07-02', revenue_cents: null, count: 0 },
      ],
      revenueByCategoryRows: [{ category: 'Wigs', revenue_cents: '5000', count: 2 }],
      revenueByServiceRows: [{ service_id: 1, name: 'Sew-in', category: 'Weaves', revenue_cents: '3000', count: 1 }],
      bookingVolumeRows: [
        { bucket: new Date('2026-07-01T00:00:00Z'), status: 'confirmed', count: 3 },
        { bucket: new Date('2026-07-01T00:00:00Z'), status: 'no_show', count: 1 },
      ],
      statusTotalRows: [
        { status: 'confirmed', count: 3 },
        { status: 'completed', count: 10 },
        { status: 'cancelled', count: 2 },
        { status: 'no_show', count: 1 },
      ],
      bookingsByWeekdayRows: [{ weekday: 3, count: 4 }],
      noShowByCategoryRows: [{ category: 'Wigs', no_show_count: 1, total: 8 }],
      newVsReturningRow: { new_customers: 5, returning_customers: 9 },
      billingTotalsRow: { total_cents: '8500', count: 3 },
      upcomingLoadRow: { next_7_days: 4, next_30_days: 12 },
      now: new Date('2026-08-01T00:00:00Z'),
    });

    assert.strictEqual(out.range.from, '2026-07-01');
    assert.strictEqual(out.range.to, '2026-07-31');
    assert.strictEqual(out.range.granularity, 'day');

    assert.deepStrictEqual(out.revenueOverTime, [
      { bucket: '2026-07-01', revenueCents: 5000, count: 2 },
      { bucket: '2026-07-02', revenueCents: 0, count: 0 },
    ]);
    assert.deepStrictEqual(out.revenueByCategory, [{ category: 'Wigs', revenueCents: 5000, count: 2 }]);
    assert.deepStrictEqual(out.revenueByService, [{ serviceId: 1, name: 'Sew-in', category: 'Weaves', revenueCents: 3000, count: 1 }]);
    assert.deepStrictEqual(out.bookingVolumeOverTime, [
      { bucket: '2026-07-01', status: 'confirmed', count: 3 },
      { bucket: '2026-07-01', status: 'no_show', count: 1 },
    ]);
    assert.deepStrictEqual(out.bookingsByWeekday, [{ weekday: 3, count: 4 }]);

    // statusTotals.total = 3+10+2+1 = 16; no-show rate = 1/16, cancellation = 2/16
    assert.deepStrictEqual(out.statusTotals, { confirmed: 3, completed: 10, cancelled: 2, no_show: 1, total: 16 });
    assert.strictEqual(out.noShowRate, 1 / 16);
    assert.strictEqual(out.cancellationRate, 2 / 16);

    assert.deepStrictEqual(out.noShowRateByCategory, [{ category: 'Wigs', noShowCount: 1, total: 8, rate: 1 / 8 }]);
    assert.deepStrictEqual(out.newVsReturning, { new: 5, returning: 9 });
    assert.deepStrictEqual(out.billingTotals, { totalCents: 8500, count: 3 });
    // avgTicketCents = round(8500/3) = 2833
    assert.strictEqual(out.avgTicketCents, 2833);
    assert.deepStrictEqual(out.upcomingLoad, { next7Days: 4, next30Days: 12 });
    assert.strictEqual(out.generatedAt, '2026-08-01T00:00:00.000Z');
  });

  test('shapeDashboardMetrics: zero-appointment / zero-billing range never divides by zero (0, not NaN)', () => {
    const out = shapeDashboardMetrics({
      range: { fromYmd: '2026-01-01', toYmd: '2026-01-01', days: 1 },
      granularity: 'day',
      revenueOverTimeRows: [],
      revenueByCategoryRows: [],
      revenueByServiceRows: [],
      bookingVolumeRows: [],
      statusTotalRows: [],
      bookingsByWeekdayRows: [],
      noShowByCategoryRows: [],
      newVsReturningRow: undefined,
      billingTotalsRow: { total_cents: '0', count: 0 },
      upcomingLoadRow: undefined,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    assert.strictEqual(out.noShowRate, 0);
    assert.strictEqual(out.cancellationRate, 0);
    assert.strictEqual(out.avgTicketCents, 0);
    assert.strictEqual(Number.isNaN(out.noShowRate), false);
    assert.deepStrictEqual(out.newVsReturning, { new: 0, returning: 0 });
    assert.deepStrictEqual(out.upcomingLoad, { next7Days: 0, next30Days: 0 });
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
