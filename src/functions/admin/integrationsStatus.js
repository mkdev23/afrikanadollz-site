// GET /api/staffconsole/integrations-status — read-only status for admin.html's Integrations tab.
//
// Fixes a real bug: the tab used to let staff type a Shopify domain/API credential into fields that
// saved to the generic `settings` key-value store (src/functions/admin/settings.js) — a store
// lib/shopify.js never reads. Filling in that form had zero effect on the live integration, which
// actually reads SHOPIFY_STORE_DOMAIN/SHOPIFY_STOREFRONT_ACCESS_TOKEN directly from the Function
// App's environment (local.settings.json locally, Azure app settings in production — see
// infra/main.bicep). Real config is a deploy-time secret, not something that should be admin-UI-
// editable anyway, so this endpoint replaces the old editable form with an honest, read-only status:
// is each integration actually configured right now, and (for Shopify only, since its domain isn't
// secret) what domain is it pointed at. Never returns the Shopify token or any Stripe key — those
// stay server-side, exactly as before.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { requireAdmin } = require('../../../lib/adminAuth');
const stripeLib = require('../../../lib/stripe');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function isRealValue(v) {
  return !!v && !v.startsWith('REPLACE_ME');
}

async function adminIntegrationsStatusHandler(request, context) {
  const db = getPool();
  const auth = await requireAdmin(request, db);
  if (!auth.ok) return { status: auth.status, jsonBody: auth.jsonBody };

  try {
    const shopifyConfigured = isRealValue(process.env.SHOPIFY_STORE_DOMAIN) && isRealValue(process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN);
    const stripeConfigured = stripeLib.isConfigured();
    return {
      status: 200,
      jsonBody: {
        shopify: {
          connected: shopifyConfigured,
          domain: shopifyConfigured ? process.env.SHOPIFY_STORE_DOMAIN : null,
        },
        stripe: {
          connected: stripeConfigured,
        },
      },
    };
  } catch (err) {
    context.error('GET /api/staffconsole/integrations-status failed:', err);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  }
}

app.http('adminIntegrationsStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staffconsole/integrations-status',
  handler: adminIntegrationsStatusHandler,
});

module.exports = { adminIntegrationsStatusHandler };
