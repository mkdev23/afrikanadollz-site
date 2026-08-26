// Applies db/schema.sql against DATABASE_URL. Run with: node db/migrate.js
// Requires the `pg` dependency declared in package.json (npm install first).
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Add it to your environment (e.g. via Vercel/Neon) before running migrations.');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = new Client({ connectionString });

  await client.connect();
  try {
    console.log('Applying db/schema.sql...');
    await client.query(sql);
    console.log('Schema applied successfully.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
