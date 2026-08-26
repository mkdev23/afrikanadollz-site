// GET /api/staffconsole/availability-rules — Diaka's recurring weekly hours, for admin.html's weekly-hours
//                                       editor (one row per weekday, 0=Sunday..6=Saturday).
// PUT /api/staffconsole/availability-rules — replace the whole rule set atomically (delete-all + re-insert
//                                       inside one transaction). admin.html's editor always submits
//                                       the complete set (at most one rule per weekday, matching the
//                                       one-row-per-day UI the plan asks for) rather than diffing
//                                       individual rows, so a full replace is the simplest correct
//                                       operation and avoids a whole separate patch/diff endpoint.
// Both behind requireAdmin(). No date/DST math here — availability_rules stores bare local TIME
// values, same as the seed data in db/seed.js; the DST-aware conversion only happens where a rule
// gets resolved against a calendar date, in lib/availability.js's computeSlots (used by
// /api/availability.js and /api/book.js, untouched by this file).
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function validateRules(rules) {
  if (!Array.isArray(rules)) return ['rules must be an array'];

  const errors = [];
  const seenWeekdays = new Set();
  rules.forEach((r, i) => {
    if (!r || typeof r !== 'object') {
      errors.push(`rules[${i}] must be an object`);
      return;
    }
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) {
      errors.push(`rules[${i}].weekday must be an integer 0-6 (0=Sunday)`);
    } else if (seenWeekdays.has(r.weekday)) {
      errors.push(`rules[${i}].weekday (${r.weekday}) is duplicated — only one rule per weekday is supported`);
    } else {
      seenWeekdays.add(r.weekday);
    }
    const startOk = typeof r.start_time === 'string' && TIME_RE.test(r.start_time);
    const endOk = typeof r.end_time === 'string' && TIME_RE.test(r.end_time);
    if (!startOk) errors.push(`rules[${i}].start_time must be HH:MM`);
    if (!endOk) errors.push(`rules[${i}].end_time must be HH:MM`);
    if (startOk && endOk && r.start_time >= r.end_time) {
      errors.push(`rules[${i}].start_time must be before end_time`);
    }
  });
  return errors;
}

async function readRules(db) {
  const { rows } = await db.query(
    'SELECT id, weekday, start_time, end_time FROM availability_rules ORDER BY weekday, start_time'
  );
  return rows;
}

async function adminAvailabilityRulesGetHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const rules = await readRules(db);
    return { status: 200, jsonBody: { rules } };
  } catch (err) {
    context.error('GET /api/staffconsole/availability-rules failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function adminAvailabilityRulesPutHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const rules = body && body.rules;
  const errors = validateRules(rules);
  if (errors.length) return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM availability_rules');
    for (const r of rules) {
      await client.query(
        'INSERT INTO availability_rules (weekday, start_time, end_time) VALUES ($1, $2, $3)',
        [r.weekday, r.start_time, r.end_time]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    context.error('PUT /api/staffconsole/availability-rules failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  } finally {
    client.release();
  }

  try {
    const updated = await readRules(db);
    return { status: 200, jsonBody: { rules: updated } };
  } catch (err) {
    // The write already committed successfully — a failure re-reading it back isn't a failed save,
    // just a failed confirmation echo. Say so rather than reporting the PUT itself as a 500.
    context.error('PUT /api/staffconsole/availability-rules: saved OK but re-read failed:', err);
    return { status: 200, jsonBody: { rules: [], warning: 'Saved, but could not re-read the updated rules.' } };
  }
}

app.http('adminAvailabilityRulesGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/availability-rules',
  handler: adminAvailabilityRulesGetHandler,
});

app.http('adminAvailabilityRulesPut', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'staffconsole/availability-rules',
  handler: adminAvailabilityRulesPutHandler,
});

module.exports = { adminAvailabilityRulesGetHandler, adminAvailabilityRulesPutHandler, validateRules };
