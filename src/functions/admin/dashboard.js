// GET /api/staffconsole/dashboard?from=&to=&days= — aggregated business metrics for admin.html's
// "Dashboard" tab: revenue over time, revenue by category/service, booking volume over time, no-show/
// cancellation rates (overall and by category), bookings by day-of-week, new-vs-returning customers,
// average ticket size, and upcoming (next 7/30 day) confirmed load. All the real SQL aggregation lives
// in lib/dashboardMetrics.js's fetchDashboardMetrics(), shared unchanged with
// src/functions/admin/dashboardInsights.js so the queries exist in exactly one place.
//
// Query params (all optional): `from`/`to` as 'YYYY-MM-DD' (both required together to take effect), or
// `days` (a lookback window ending today, default lib/dashboardMetrics.js's DEFAULT_RANGE_DAYS = 90,
// clamped to MAX_RANGE_DAYS = 366). See resolveDateRange()'s JSDoc for the exact precedence/fallback
// rules. `upcomingLoad` is always computed from *now*, independent of whatever range was requested.
//
// Behind requireAdmin(), same as every other src/functions/admin/*.js file.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');
const { fetchDashboardMetrics } = require('../../../lib/dashboardMetrics');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function adminDashboardHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  const rawQuery = {
    from: request.query.get('from') || undefined,
    to: request.query.get('to') || undefined,
    days: request.query.get('days') || undefined,
  };

  try {
    const metrics = await fetchDashboardMetrics(db, rawQuery, new Date());
    return { status: 200, jsonBody: { metrics } };
  } catch (err) {
    context.error('GET /api/staffconsole/dashboard failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminDashboard', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/dashboard',
  handler: adminDashboardHandler,
});

module.exports = { adminDashboardHandler };
