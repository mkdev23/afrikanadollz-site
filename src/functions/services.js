// GET /api/services — active services grouped by category, per the plan. Powers book.html's
// category tabs (SELECT DISTINCT category becomes literal here, since we group in JS instead).
//
// Ported from the original Vercel-style api/services.js to the Azure Functions Node.js v4
// programming model: same query, same response shape ({ categories: {...} }), same 200/500 status
// codes. The only behavioral difference is that a non-GET request now gets Azure's own 404 (no route
// registered for that method) instead of an explicit 405 JSON body — Azure's HTTP router rejects
// unmatched methods before our handler ever runs, so there's nothing left for us to check.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function servicesHandler(request, context) {
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, name, description, duration_min, buffer_min, sort_order, price_cents, image_url
       FROM services WHERE active = true ORDER BY category, sort_order, name`
    );

    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }

    return { status: 200, jsonBody: { categories: grouped } };
  } catch (err) {
    context.error('GET /api/services failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('services', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'services',
  handler: servicesHandler,
});

module.exports = { servicesHandler };
