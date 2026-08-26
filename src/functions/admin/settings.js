// GET/PUT /api/staffconsole/settings — a tiny generic key-value store backing admin.html's "Integrations"
// tab. Currently the only consumer is a Shopify scaffold (store domain + API credential fields,
// "Save", a "Not yet connected" status) — the user has explicitly NOT decided the real Shopify
// integration's shape yet, so this deliberately stays a dumb key/JSONB-value store rather than
// growing Shopify-specific columns or logic. Any future settings (or a real Shopify connection) can
// reuse the same GET/PUT surface with a different `key` and `value` shape, no migration needed.
// Behind requireAdmin().
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const KEY_RE = /^[a-z0-9_-]+$/i;

async function adminSettingsGetHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const { rows } = await db.query('SELECT key, value, updated_at FROM settings');
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    return { status: 200, jsonBody: { settings } };
  } catch (err) {
    context.error('GET /api/staffconsole/settings failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

async function adminSettingsPutHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const key = body && body.key;
  const value = body && body.value;

  const errors = [];
  if (!key || typeof key !== 'string' || !KEY_RE.test(key)) {
    errors.push('key is required and must contain only letters, numbers, "_", or "-"');
  }
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('value is required and must be a JSON object');
  }
  if (errors.length) return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };

  try {
    const { rows } = await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value)]
    );
    return { status: 200, jsonBody: { setting: rows[0] } };
  } catch (err) {
    context.error('PUT /api/staffconsole/settings failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminSettingsGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/settings',
  handler: adminSettingsGetHandler,
});

app.http('adminSettingsPut', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'staffconsole/settings',
  handler: adminSettingsPutHandler,
});

module.exports = { adminSettingsGetHandler, adminSettingsPutHandler };
