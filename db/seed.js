// Seeds `services` + `availability_rules` rows. Run with: node db/seed.js
//
// `services` is a REPLACE-ALL seed (delete-then-insert), not skip-if-exists: the catalogue below is
// real data transcribed directly from Diaka's live Acuity booking page (copied by the site owner),
// replacing an earlier placeholder guess. Since no real bookings exist against the old placeholder
// service ids yet, wiping and reinserting is safe pre-launch. `availability_rules` and `admin_account`
// remain skip-if-exists (see below) since those aren't being refreshed by this change.
//
// Still placeholder: business hours (10:00-18:00) — the site's footer only says "Tue - Sat, by
// appointment - closed Sun & Mon" with no clock times stated anywhere, so this is still an invented
// default pending real hours from Diaka. `buffer_min` per service is also an estimate (not from
// Acuity, which doesn't expose buffer time in its public booking page) — a rough scale from the
// service's own duration, not a confirmed real value.
'use strict';

const { Client } = require('pg');
const { hashPassword } = require('../lib/adminAuth');

// Source of truth: Acuity's own embedded appointment-type JSON, read directly off
// https://app.acuityscheduling.com/schedule.php?owner=17570553 (a `var BUSINESS = {...}` blob in the
// page's raw HTML — Acuity's booking widget is a JS SPA, so a plain page-content fetch only ever
// returns the shell; the appointment data only shows up in the *raw, unrendered* HTML source, which
// is where this was actually read from). Real category names, prices, durations, and each service's
// real thumbnail image (Acuity's own CDN) all came from that same blob — not guessed or re-transcribed
// by hand from a screenshot this time. Acuity itself leaves "Summer Special"/"Soft beat"/"Glam beat"/
// "Frontal ponytail" in a single uncategorized bucket (empty category string) — the Specials/Makeup
// split below is our own categorization on top of that, per the site owner's explicit direction.
const SERVICES = [
  // ---- Specials ----
  { category: 'Specials', name: 'Summer Special',   description: 'Wig install & Makeup',                                                                                       duration_min: 120, buffer_min: 20, price_cents: null,  sort_order: 1, image_url: null },
  { category: 'Specials', name: 'Frontal ponytail', description: null,                                                                                                          duration_min: 30,  buffer_min: 10, price_cents: 12000, sort_order: 2, image_url: null },
  { category: 'Specials', name: 'Glam beat💄 & install', description: 'Wig installation plus glam beat 💄 (lashes included). Wig must be dropped off 2-3 days prior to the appointment date.', duration_min: 30, buffer_min: 15, price_cents: 25000, sort_order: 3, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-24971991.jpeg?1626835401' },
  // ---- Makeup ----
  { category: 'Makeup', name: 'Soft beat💄',  description: 'Natural makeup with one color eye shadow, lashes included.',       duration_min: 45, buffer_min: 15, price_cents: 8500,  sort_order: 1, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-thumb-25264926.jpeg?1750425583' },
  { category: 'Makeup', name: 'Glam beat 💄', description: 'Full makeup with eye shadow of your choice, lashes included.',      duration_min: 90, buffer_min: 15, price_cents: 10000, sort_order: 2, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-thumb-25264965.jpeg?1750425687' },
  // ---- Braids ----
  { category: 'Braids', name: 'Individuals medium length', description: null,  duration_min: 190, buffer_min: 20, price_cents: 22500, sort_order: 1, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-14130809.jpeg?1750428759' },
  { category: 'Braids', name: 'Small knotless braids',     description: null,  duration_min: 250, buffer_min: 20, price_cents: 30000, sort_order: 2, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-14509125.jpeg?1590170830' },
  { category: 'Braids', name: 'Large knotless',            description: null,  duration_min: 120, buffer_min: 20, price_cents: 18000, sort_order: 3, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-16547155.jpeg?1598258771' },
  { category: 'Braids', name: 'Medium bohemian knotless',  description: null,  duration_min: 400, buffer_min: 20, price_cents: 30000, sort_order: 4, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-16547523.jpeg?1608015421' },
  { category: 'Braids', name: 'Fulani braids half & half',  description: 'Half braids, half sew-in or quick weave. Must provide the hair.',   duration_min: 120, buffer_min: 20, price_cents: 16000, sort_order: 5, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-79873571.jpeg?1750425186' },
  // ---- Sew-Ins & Installation ----
  { category: 'Sew-Ins & Installation', name: 'Frontal wig install 🌻',              description: 'Includes wig customization, braid down, bald cap under wig & installation of unit. Styling included (silk press or curls; curly textured hair is extra). Client must provide a brand new wig; drop-off required 2-5 days in advance.', duration_min: 140, buffer_min: 20, price_cents: 18500, sort_order: 1, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-14130670.jpeg?1750425377' },
  { category: 'Sew-Ins & Installation', name: 'Closure sewing',                      description: 'Includes closure customization (2x6, 4x4 & 5x5 lace). Hair is braided down, oiled, and tracks sewn in (glued or glueless install). Styling included. At least 2-3 bundles of hair required, extra bundles +$15.', duration_min: 80, buffer_min: 15, price_cents: 17000, sort_order: 2, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-18983774.jpeg?1626835847' },
  { category: 'Sew-Ins & Installation', name: 'Re-install frontal lace',             description: 'Cap method, re-application of the wig, and styling. Come with wig washed, no glue residue. +$20 for braids.', duration_min: 60, buffer_min: 15, price_cents: 14000, sort_order: 3, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-23142449.jpeg?1626835896' },
  { category: 'Sew-Ins & Installation', name: 'Afrikanadollz FREE installation 🥳',  description: 'Free with any wig purchase over $400 on the Afrikanadollz website. Must come braid down, or +$30 for braids. Includes cap method + wig styling.', duration_min: 60, buffer_min: 15, price_cents: 0, sort_order: 4, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-thumb-23142599.jpeg?1626835222' },
  // ---- Wig Maintenance ----
  { category: 'Wig Maintenance', name: 'Revamp Closure Wig 💇🏾‍♀️', description: 'Wash & style only. The wig must have been made by Diaka for this service (can take 2-3 days depending on condition). Tightening loose tracks is an extra fee. Please contact (267) 481-4058 before booking.', duration_min: 60, buffer_min: 20, price_cents: 8000, sort_order: 1, image_url: 'https://cdn-s.acuityscheduling.com/appointmentType-18984213.jpeg?1608016812' },
];

// Tue(2)-Sat(6), 10:00-18:00 America/New_York wall clock. Placeholder — confirm real hours with Diaka.
const AVAILABILITY_RULES = [2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_time: '10:00',
  end_time: '18:00',
}));

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows: svcCount } = await client.query('SELECT count(*)::int AS n FROM services');
    await client.query('DELETE FROM services');
    for (const s of SERVICES) {
      await client.query(
        `INSERT INTO services (category, name, description, duration_min, buffer_min, price_cents, image_url, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
        [s.category, s.name, s.description, s.duration_min, s.buffer_min, s.price_cents, s.image_url, s.sort_order]
      );
    }
    console.log(`Replaced ${svcCount[0].n} old service row(s) with ${SERVICES.length} real services from Acuity.`);

    const { rows: ruleCount } = await client.query('SELECT count(*)::int AS n FROM availability_rules');
    if (ruleCount[0].n > 0) {
      console.log(`availability_rules already has ${ruleCount[0].n} row(s) — skipping rule seed.`);
    } else {
      for (const r of AVAILABILITY_RULES) {
        await client.query(
          `INSERT INTO availability_rules (weekday, start_time, end_time) VALUES ($1, $2, $3)`,
          [r.weekday, r.start_time, r.end_time]
        );
      }
      console.log(`Inserted ${AVAILABILITY_RULES.length} availability rules (Tue-Sat, 10:00-18:00 America/New_York — PLACEHOLDER).`);
    }

    // ---- admin_account bootstrap ----
    // One-time seed of the single admin identity (db/schema.sql's admin_account table) from
    // ADMIN_EMAIL/ADMIN_PASSWORD env vars, so the admin password can move out of a static env var
    // (which the running app can never rewrite) into the DB (which it can, via the new
    // /api/staffconsole/request-password-reset + /api/staffconsole/reset-password endpoints). Only runs once —
    // if admin_account already has its one row, this is a no-op, exactly like the services/
    // availability_rules seeds above. Does NOT exit(1) when the env vars are missing: an operator
    // who's just running `npm run db:seed` for the booking data shouldn't have that fail outright
    // for an unrelated feature — it logs a clear, actionable message and moves on instead.
    const { rows: adminCount } = await client.query('SELECT count(*)::int AS n FROM admin_account');
    if (adminCount[0].n > 0) {
      console.log('admin_account already has a row — skipping admin bootstrap seed.');
    } else {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminEmail || !adminPassword) {
        console.log(
          'ADMIN_EMAIL and/or ADMIN_PASSWORD are not set — skipping admin_account bootstrap seed. ' +
          'Set both (see local.settings.json for the PLACEHOLDER values that need real ones) and re-run ' +
          '`node db/seed.js` to create the initial admin login, or admin login will stay unconfigured (500).'
        );
      } else {
        const passwordHash = hashPassword(adminPassword);
        await client.query(
          `INSERT INTO admin_account (id, email, password_hash) VALUES (1, $1, $2)`,
          [adminEmail, passwordHash]
        );
        console.log(`Seeded initial admin_account row for ${adminEmail}. Change ADMIN_EMAIL/ADMIN_PASSWORD or use the admin "Forgot password?" flow afterward — ADMIN_PASSWORD is only read by this one-time seed, never by login itself.`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
