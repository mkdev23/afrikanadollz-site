// Pure date-range/shaping logic + the DB-touching aggregation query for the admin "Dashboard" tab
// (admin.html) and its AI-insights sidecar (src/functions/admin/dashboardInsights.js). Split the same
// way lib/availability.js is split from src/functions/availability.js: everything that doesn't need a
// live `db` handle (resolveDateRange, pickGranularity, shapeDashboardMetrics) is a plain function that
// can be unit-tested with synthetic input; fetchDashboardMetrics is the one place that actually runs
// SQL, and is shared by BOTH src/functions/admin/dashboard.js and src/functions/admin/dashboardInsights.js
// so the aggregation queries exist in exactly one place.
//
// "Sales"/"revenue" here always means billing_entries (the real payment ledger — amount_cents actually
// collected, via method/source), never services.price_cents (the list price) — not every appointment is
// paid in full or immediately, and services.price_cents doesn't even apply to every historical service
// (some are null). See db/schema.sql's billing_entries comment for the full rationale.
'use strict';

const { zonedWallTimeToUtc } = require('./availability');

// Same salon-local zone every other zone-aware piece of this codebase hardcodes (lib/availability.js's
// caller, admin.html's TIMEZONE, book.html) — revenue/booking buckets should line up with the calendar
// days Diaka actually experiences, not UTC's, and just about all of her business hours sit far enough
// from UTC midnight that the zone choice materially changes which bucket a late-evening appointment
// lands in.
const TIMEZONE = 'America/New_York';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Default lookback window when no from/to/days is given, and the hard ceiling on how wide a range can
// be requested at all -- this is an aggregation endpoint, not an export-everything endpoint, and an
// unbounded range would mean an unbounded number of GROUP BY buckets/rows out of an otherwise cheap set
// of indexed queries. 366 comfortably covers "the whole trailing year" for a small single-operator salon.
const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 366;

// "sensible": daily buckets read fine up to about a month of points on a simple bar/line chart before
// they get too dense to label; beyond that, weekly buckets keep the chart readable. Matches the task's
// own suggested threshold.
const DAILY_GRANULARITY_MAX_DAYS = 31;

function ymdInZone(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function parseYmd(str) {
  const [y, m, d] = str.split('-').map(Number);
  return { y, m, d };
}

// Calendar-date arithmetic on a 'YYYY-MM-DD' string. Deliberately timezone-independent (like
// lib/availability.js's addDays/weekdayOf) -- adding/subtracting whole calendar days doesn't depend on
// which zone you're asking from, only the zone conversion of the resulting date's midnight (done
// separately, via zonedWallTimeToUtc) does.
function addDaysYmd(str, n) {
  const { y, m, d } = parseYmd(str);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function daysBetweenYmd(fromStr, toStr) {
  const f = parseYmd(fromStr);
  const t = parseYmd(toStr);
  const fMs = Date.UTC(f.y, f.m - 1, f.d);
  const tMs = Date.UTC(t.y, t.m - 1, t.d);
  return Math.round((tMs - fMs) / 86400000);
}

function ymdToUtcInstant(str) {
  const { y, m, d } = parseYmd(str);
  return zonedWallTimeToUtc(y, m, d, 0, 0, TIMEZONE);
}

/**
 * Resolve the dashboard's from/to/days query params into a concrete local-calendar-day range.
 * - Explicit `from` + `to` (both 'YYYY-MM-DD') wins outright.
 * - Otherwise `to` defaults to today (in TIMEZONE) and `from` is `days` (default DEFAULT_RANGE_DAYS,
 *   clamped to [1, MAX_RANGE_DAYS]) calendar days back from `to`, inclusive of both ends.
 * - An inverted explicit range (from > to) is swapped rather than rejected -- a staff member fat-
 *   fingering the two query params shouldn't get a 400, just the range they clearly meant.
 * - A range wider than MAX_RANGE_DAYS is clamped by pulling `from` forward, keeping `to` fixed.
 *
 * @param {{from?:string, to?:string, days?:string|number}} query
 * @param {Date} [now]
 * @returns {{fromYmd:string, toYmd:string, from:Date, to:Date, days:number}} `from`/`to` are UTC
 *   instants: `from` is the range's first included instant, `to` is the EXCLUSIVE upper bound (local
 *   midnight the day after `toYmd`) -- built this way so every query below can do a plain
 *   `col >= $from AND col < $to` with no per-query +interval fiddling.
 */
function resolveDateRange(query, now) {
  now = now instanceof Date ? now : new Date();
  const nowYmd = ymdInZone(now);

  const hasFrom = query && typeof query.from === 'string' && YMD_RE.test(query.from);
  const hasTo = query && typeof query.to === 'string' && YMD_RE.test(query.to);

  let fromYmd;
  let toYmd;
  if (hasFrom && hasTo) {
    fromYmd = query.from;
    toYmd = query.to;
  } else {
    toYmd = hasTo ? query.to : nowYmd;
    let days = DEFAULT_RANGE_DAYS;
    if (query && query.days !== undefined && query.days !== null && query.days !== '') {
      const n = Number(query.days);
      if (Number.isFinite(n) && n > 0) days = Math.floor(n);
    }
    days = Math.min(Math.max(days, 1), MAX_RANGE_DAYS);
    fromYmd = hasFrom ? query.from : addDaysYmd(toYmd, -(days - 1));
  }

  if (fromYmd > toYmd) {
    const tmp = fromYmd;
    fromYmd = toYmd;
    toYmd = tmp;
  }

  let spanDays = daysBetweenYmd(fromYmd, toYmd) + 1; // inclusive day count
  if (spanDays > MAX_RANGE_DAYS) {
    fromYmd = addDaysYmd(toYmd, -(MAX_RANGE_DAYS - 1));
    spanDays = MAX_RANGE_DAYS;
  }

  return {
    fromYmd,
    toYmd,
    from: ymdToUtcInstant(fromYmd),
    to: ymdToUtcInstant(addDaysYmd(toYmd, 1)),
    days: spanDays,
  };
}

/** ≤31 calendar days -> daily buckets, otherwise weekly. See DAILY_GRANULARITY_MAX_DAYS's comment. */
function pickGranularity(days) {
  return days <= DAILY_GRANULARITY_MAX_DAYS ? 'day' : 'week';
}

function centsToNumber(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

function countToNumber(v) {
  return Number(v) || 0;
}

// A date_trunc(..., ts AT TIME ZONE tz) result comes back from `pg` as a JS Date built from a naive
// (zone-less) timestamp string, which node-pg parses as if it were UTC -- so the *wall-clock* local
// bucket start is exactly what .toISOString().slice(0,10) reads back out, with no further zone
// conversion needed here. (Same trick this codebase already relies on implicitly wherever a naive
// timestamp round-trips through pg -- documented here since it's easy to get backwards.)
function bucketToYmd(bucket) {
  if (bucket instanceof Date) return bucket.toISOString().slice(0, 10);
  return String(bucket).slice(0, 10);
}

/**
 * Shape the raw `pg` result rows from fetchDashboardMetrics's queries into the JSON the dashboard
 * endpoint returns (and the same object the AI-insights prompt is built from). Kept as a standalone
 * pure function -- takes plain row arrays, not a `db` -- specifically so it's testable with synthetic
 * fixtures instead of a mocked pg.query() (see this project's test/ house style note in the task).
 */
function shapeDashboardMetrics({
  range,
  granularity,
  revenueOverTimeRows,
  revenueByCategoryRows,
  revenueByServiceRows,
  bookingVolumeRows,
  statusTotalRows,
  bookingsByWeekdayRows,
  noShowByCategoryRows,
  newVsReturningRow,
  billingTotalsRow,
  upcomingLoadRow,
  now,
}) {
  const revenueOverTime = (revenueOverTimeRows || []).map((r) => ({
    bucket: bucketToYmd(r.bucket),
    revenueCents: centsToNumber(r.revenue_cents),
    count: countToNumber(r.count),
  }));

  const revenueByCategory = (revenueByCategoryRows || []).map((r) => ({
    category: r.category,
    revenueCents: centsToNumber(r.revenue_cents),
    count: countToNumber(r.count),
  }));

  const revenueByService = (revenueByServiceRows || []).map((r) => ({
    serviceId: r.service_id,
    name: r.name,
    category: r.category,
    revenueCents: centsToNumber(r.revenue_cents),
    count: countToNumber(r.count),
  }));

  const bookingVolumeOverTime = (bookingVolumeRows || []).map((r) => ({
    bucket: bucketToYmd(r.bucket),
    status: r.status,
    count: countToNumber(r.count),
  }));

  const bookingsByWeekday = (bookingsByWeekdayRows || []).map((r) => ({
    weekday: countToNumber(r.weekday), // 0=Sunday .. 6=Saturday, local (TIMEZONE) weekday
    count: countToNumber(r.count),
  }));

  const statusTotals = { confirmed: 0, completed: 0, cancelled: 0, no_show: 0 };
  let totalAppointments = 0;
  for (const r of statusTotalRows || []) {
    const count = countToNumber(r.count);
    if (Object.prototype.hasOwnProperty.call(statusTotals, r.status)) statusTotals[r.status] = count;
    totalAppointments += count;
  }
  const noShowRate = totalAppointments > 0 ? statusTotals.no_show / totalAppointments : 0;
  const cancellationRate = totalAppointments > 0 ? statusTotals.cancelled / totalAppointments : 0;

  const noShowRateByCategory = (noShowByCategoryRows || []).map((r) => {
    const total = countToNumber(r.total);
    const noShowCount = countToNumber(r.no_show_count);
    return { category: r.category, noShowCount, total, rate: total > 0 ? noShowCount / total : 0 };
  });

  const newCount = newVsReturningRow ? countToNumber(newVsReturningRow.new_customers) : 0;
  const returningCount = newVsReturningRow ? countToNumber(newVsReturningRow.returning_customers) : 0;

  const billingTotalCents = billingTotalsRow ? centsToNumber(billingTotalsRow.total_cents) : 0;
  const billingCount = billingTotalsRow ? countToNumber(billingTotalsRow.count) : 0;
  const avgTicketCents = billingCount > 0 ? Math.round(billingTotalCents / billingCount) : 0;

  return {
    range: { from: range.fromYmd, to: range.toYmd, days: range.days, granularity },
    revenueOverTime,
    revenueByCategory,
    revenueByService,
    bookingVolumeOverTime,
    bookingsByWeekday,
    statusTotals: { ...statusTotals, total: totalAppointments },
    noShowRate,
    cancellationRate,
    noShowRateByCategory,
    newVsReturning: { new: newCount, returning: returningCount },
    billingTotals: { totalCents: billingTotalCents, count: billingCount },
    avgTicketCents,
    upcomingLoad: {
      next7Days: upcomingLoadRow ? countToNumber(upcomingLoadRow.next_7_days) : 0,
      next30Days: upcomingLoadRow ? countToNumber(upcomingLoadRow.next_30_days) : 0,
    },
    generatedAt: (now instanceof Date ? now : new Date()).toISOString(),
  };
}

/**
 * Run every aggregation query for the dashboard/insights feature and shape the result. The one place
 * both src/functions/admin/dashboard.js (the metrics endpoint) and src/functions/admin/dashboardInsights.js
 * (the AI-insights endpoint, on `regenerate`) get their numbers from -- so the SQL exists exactly once.
 * @param {{query: Function}} db - a pg Pool (or compatible)
 * @param {object} rawQuery - the raw {from,to,days} query-param-shaped object (e.g. from
 *   Object.fromEntries(request.query) in the caller)
 * @param {Date} [now]
 */
async function fetchDashboardMetrics(db, rawQuery, now) {
  now = now instanceof Date ? now : new Date();
  const range = resolveDateRange(rawQuery, now);
  const granularity = pickGranularity(range.days);

  const next7 = new Date(now.getTime() + 7 * 86400000);
  const next30 = new Date(now.getTime() + 30 * 86400000);

  const [
    revenueOverTimeRes,
    revenueByCategoryRes,
    revenueByServiceRes,
    bookingVolumeRes,
    statusTotalRes,
    bookingsByWeekdayRes,
    noShowByCategoryRes,
    newVsReturningRes,
    billingTotalsRes,
    upcomingLoadRes,
  ] = await Promise.all([
    db.query(
      `SELECT date_trunc($3, created_at AT TIME ZONE $4) AS bucket,
              SUM(amount_cents)::bigint AS revenue_cents, COUNT(*)::int AS count
       FROM billing_entries
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY bucket ORDER BY bucket`,
      [range.from, range.to, granularity, TIMEZONE]
    ),
    db.query(
      `SELECT s.category AS category, SUM(be.amount_cents)::bigint AS revenue_cents, COUNT(*)::int AS count
       FROM billing_entries be
       JOIN appointments a ON a.id = be.appointment_id
       JOIN services s ON s.id = a.service_id
       WHERE be.created_at >= $1 AND be.created_at < $2
       GROUP BY s.category ORDER BY revenue_cents DESC`,
      [range.from, range.to]
    ),
    db.query(
      `SELECT s.id AS service_id, s.name AS name, s.category AS category,
              SUM(be.amount_cents)::bigint AS revenue_cents, COUNT(*)::int AS count
       FROM billing_entries be
       JOIN appointments a ON a.id = be.appointment_id
       JOIN services s ON s.id = a.service_id
       WHERE be.created_at >= $1 AND be.created_at < $2
       GROUP BY s.id, s.name, s.category ORDER BY revenue_cents DESC`,
      [range.from, range.to]
    ),
    db.query(
      `SELECT date_trunc($3, start_at AT TIME ZONE $4) AS bucket, status, COUNT(*)::int AS count
       FROM appointments
       WHERE start_at >= $1 AND start_at < $2
       GROUP BY bucket, status ORDER BY bucket`,
      [range.from, range.to, granularity, TIMEZONE]
    ),
    db.query(
      `SELECT status, COUNT(*)::int AS count
       FROM appointments WHERE start_at >= $1 AND start_at < $2
       GROUP BY status`,
      [range.from, range.to]
    ),
    db.query(
      `SELECT EXTRACT(DOW FROM start_at AT TIME ZONE $3)::int AS weekday, COUNT(*)::int AS count
       FROM appointments
       WHERE start_at >= $1 AND start_at < $2
       GROUP BY weekday ORDER BY weekday`,
      [range.from, range.to, TIMEZONE]
    ),
    db.query(
      `SELECT s.category AS category,
              COUNT(*) FILTER (WHERE a.status = 'no_show')::int AS no_show_count,
              COUNT(*)::int AS total
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.start_at >= $1 AND a.start_at < $2
       GROUP BY s.category`,
      [range.from, range.to]
    ),
    db.query(
      `WITH first_appt AS (
         SELECT customer_id, MIN(start_at) AS first_start
         FROM appointments WHERE customer_id IS NOT NULL GROUP BY customer_id
       ), in_range AS (
         SELECT DISTINCT customer_id FROM appointments
         WHERE customer_id IS NOT NULL AND start_at >= $1 AND start_at < $2
       )
       SELECT
         COUNT(*) FILTER (WHERE fa.first_start >= $1)::int AS new_customers,
         COUNT(*) FILTER (WHERE fa.first_start < $1)::int AS returning_customers
       FROM in_range ir JOIN first_appt fa ON fa.customer_id = ir.customer_id`,
      [range.from, range.to]
    ),
    db.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents, COUNT(*)::int AS count
       FROM billing_entries WHERE created_at >= $1 AND created_at < $2`,
      [range.from, range.to]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE start_at < $2)::int AS next_7_days,
         COUNT(*) FILTER (WHERE start_at < $3)::int AS next_30_days
       FROM appointments
       WHERE status = 'confirmed' AND start_at >= $1 AND start_at < $3`,
      [now, next7, next30]
    ),
  ]);

  return shapeDashboardMetrics({
    range,
    granularity,
    revenueOverTimeRows: revenueOverTimeRes.rows,
    revenueByCategoryRows: revenueByCategoryRes.rows,
    revenueByServiceRows: revenueByServiceRes.rows,
    bookingVolumeRows: bookingVolumeRes.rows,
    statusTotalRows: statusTotalRes.rows,
    bookingsByWeekdayRows: bookingsByWeekdayRes.rows,
    noShowByCategoryRows: noShowByCategoryRes.rows,
    newVsReturningRow: newVsReturningRes.rows[0],
    billingTotalsRow: billingTotalsRes.rows[0],
    upcomingLoadRow: upcomingLoadRes.rows[0],
    now,
  });
}

module.exports = {
  TIMEZONE,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  DAILY_GRANULARITY_MAX_DAYS,
  resolveDateRange,
  pickGranularity,
  shapeDashboardMetrics,
  fetchDashboardMetrics,
  addDaysYmd,
};
