// One-time backfill: reformats every existing customers.phone and appointments.customer_phone value
// to lib/phone.js's canonical form. Needed because that normalization was added after this app had
// already been live for a while (see src/functions/auth/auth.js's linkOrphanGuestAppointments
// comment) — rows written before the fix keep whatever raw shape the customer originally typed
// ("(267) 481-4058", "267-481-4058", etc.), which would otherwise never equality-match a freshly
// normalized "+12674814058" and silently break both retroactive guest-appointment linking and admin
// client search for anyone who signed up/booked before this shipped.
//
// Safe to re-run: only issues an UPDATE for a row whose normalized form actually differs from what's
// stored (a second run is a clean no-op). Defaults to a dry run (reports what WOULD change, touches
// nothing) — pass --apply to actually write.
//
// Run with: node db/migrate-phone-backfill.js           (dry run, prints a report)
//           node db/migrate-phone-backfill.js --apply    (actually updates the rows)
'use strict';

const { Client } = require('pg');
const { normalizePhone } = require('../lib/phone');

async function backfillTable(client, { table, idCol, phoneCol, apply }) {
  const { rows } = await client.query(`SELECT ${idCol} AS id, ${phoneCol} AS phone FROM ${table} WHERE ${phoneCol} IS NOT NULL`);
  let changed = 0;
  const samples = [];
  for (const row of rows) {
    const normalized = normalizePhone(row.phone);
    if (normalized === row.phone) continue;
    changed++;
    if (samples.length < 10) samples.push({ id: row.id, from: row.phone, to: normalized });
    if (apply) {
      await client.query(`UPDATE ${table} SET ${phoneCol} = $1 WHERE ${idCol} = $2`, [normalized, row.id]);
    }
  }
  return { table, total: rows.length, changed, samples };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    console.log(apply ? 'Applying phone backfill...' : 'Dry run (pass --apply to actually write)...');
    const results = [];
    results.push(await backfillTable(client, { table: 'customers', idCol: 'id', phoneCol: 'phone', apply }));
    results.push(await backfillTable(client, { table: 'appointments', idCol: 'id', phoneCol: 'customer_phone', apply }));
    for (const r of results) {
      console.log(`\n${r.table}: ${r.changed}/${r.total} row(s) ${apply ? 'updated' : 'would be updated'}`);
      r.samples.forEach((s) => console.log(`  #${s.id}: "${s.from}" -> "${s.to}"`));
      if (r.changed > r.samples.length) console.log(`  ...and ${r.changed - r.samples.length} more`);
    }
    if (!apply) console.log('\nDry run complete. Re-run with --apply to write these changes.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Phone backfill failed:', err);
  process.exit(1);
});
