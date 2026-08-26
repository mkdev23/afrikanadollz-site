-- AFRIKANADOLLZ native booking system — schema
-- Applied via db/migrate.js using DATABASE_URL. Matches the data model in the approved plan
-- (so-lets-work-on-warm-waffle.md). All timestamps are TIMESTAMPTZ (stored as UTC by Postgres);
-- availability_rules times are bare local (America/New_York) wall-clock values — see lib/availability.js
-- for how those get resolved to UTC instants, DST included.

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER,
  image_url TEXT
);
ALTER TABLE services ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE services ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Diaka's recurring weekly hours, local wall-clock time. weekday: 0=Sunday .. 6=Saturday.
CREATE TABLE IF NOT EXISTS availability_rules (
  id SERIAL PRIMARY KEY,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (start_time < end_time)
);

-- One-off full/partial blocks (vacation days, appointments held outside the system, etc).
CREATE TABLE IF NOT EXISTS blocked_slots (
  id SERIAL PRIMARY KEY,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  CHECK (start_at < end_at)
);

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  notes TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',        -- confirmed | cancelled | completed | no_show
  sms_opt_in BOOLEAN NOT NULL DEFAULT false,
  sms_phone TEXT,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  manage_token TEXT NOT NULL UNIQUE,               -- customer cancel/reschedule link
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_start_at ON appointments(start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_scan ON appointments(status, sms_opt_in, reminder_sent, start_at);

-- Added for the admin page (plan step 5). Generic key-value settings store — currently backs the
-- admin.html "Integrations" tab's Shopify scaffold (store domain + API credential placeholders), but
-- deliberately generic (JSONB value, no Shopify-specific columns) since the real Shopify integration
-- shape hasn't been decided yet. One row per `key`. Additive only — does not alter any of the four
-- tables above.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Customer accounts (added for the customer-accounts feature, additive only —
-- nothing above this line is altered except the one ALTER TABLE at the bottom).
-- ============================================================================

-- A customer is anyone who's ever logged in (or is mid-login) via magic-link email or SMS OTP. Both
-- email and phone are nullable individually (either one is a valid login identity per the decision
-- to support both), but the app layer requires at least one be present before a row is created —
-- not enforced here as a DB CHECK because "at least one of two nullable columns is set" is exactly
-- the kind of constraint that's easy to satisfy in code and annoying to work around in SQL once a
-- customer later adds their second contact method to the same row.
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per magic-link or OTP send. `method` discriminates the two (rather than two separate
-- tables) since they share every other column and callers (src/functions/auth/auth.js) already
-- branch on method anyway. `secret_hash` is SHA-256 of the raw token/code — never the raw value
-- itself — so a DB dump/leak can't be replayed as a login. `identifier` is the email or phone the
-- challenge was actually sent to (denormalized off customers.email/phone) so verification can look
-- a challenge up without an extra join, and so a customer changing their email later doesn't
-- invalidate an in-flight challenge sent to the old one. `attempts` only matters for the 'sms'
-- method (a 6-digit OTP is guessable; a 24-byte magic-link token is not) — see auth.js for the cap.
--
-- `customer_id` is nullable (added for the explicit signup-vs-login feature): a brand-new
-- email/phone that's never been seen before still gets a challenge row and a code/link sent — we
-- need to confirm the person actually owns that identifier before creating any account for them —
-- but src/functions/auth/auth.js's request handler deliberately does NOT create a `customers` row
-- for an unrecognized identifier up front. `customer_id IS NULL` on a challenge row is exactly the
-- "this identifier has no account yet" signal; the customer row gets created at verify-time, once
-- the code/link is actually confirmed, and (for a fresh signup) the row is backfilled onto this
-- challenge afterward for an audit trail. For an already-known identifier, `customer_id` is set at
-- insert time exactly as before.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('email', 'sms')),
  identifier TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_lookup ON auth_challenges(method, identifier, used_at, expires_at);
-- customer_id was NOT NULL when this table was first created; relax it in place for anyone who
-- already applied the earlier schema (a fresh `CREATE TABLE IF NOT EXISTS` above is a no-op on an
-- existing table, so the ALTER is what actually lands the change there).
ALTER TABLE auth_challenges ALTER COLUMN customer_id DROP NOT NULL;

-- The manual payment/deposit ledger Diaka enters by hand from admin.html. `amount_cents` is an
-- integer (cents) rather than NUMERIC/FLOAT to sidestep any floating-point rounding entirely —
-- display code divides by 100 for presentation only. `customer_id` is nullable and denormalized off
-- appointments.customer_id: most bookings are still guest bookings with no customer_id at all, and
-- even for a linked appointment, keeping it here means GET /api/account/billing can filter directly
-- on billing_entries without a join back through appointments. `source`/`external_ref` exist purely
-- for forward compatibility with a real payment processor: every row today is `source='manual'` with
-- `external_ref` NULL, but a future Stripe/Shopify integration can write `source='stripe'` (etc.) +
-- that processor's transaction id into the same table with no migration needed.
CREATE TABLE IF NOT EXISTS billing_entries (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  customer_id INTEGER REFERENCES customers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash_app', 'zelle', 'cash', 'other', 'card')),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  external_ref TEXT,
  recorded_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_entries_appointment ON billing_entries(appointment_id);
-- `method`'s CHECK gained 'card' after this table already existed in production (Stripe
-- integration, see lib/stripe.js) -- the inline CHECK above only takes effect on a fresh install,
-- so an already-existing table needs its constraint swapped explicitly. Postgres auto-names an
-- unnamed inline CHECK as `<table>_<column>_check`, which is what the original constraint is
-- called; drop-then-recreate is the only way to widen a CHECK's allowed set (no ADD-only form
-- exists), and doing it as DROP IF EXISTS + ADD makes re-running this file safe/idempotent same as
-- every other statement here.
ALTER TABLE billing_entries DROP CONSTRAINT IF EXISTS billing_entries_method_check;
ALTER TABLE billing_entries ADD CONSTRAINT billing_entries_method_check
  CHECK (method IN ('cash_app', 'zelle', 'cash', 'other', 'card'));
-- Stripe webhooks (src/functions/payments/webhook.js) can and will redeliver the same event more
-- than once (Stripe's own retry policy on a slow/failed response, or just duplicate delivery) --
-- this partial unique index (only enforced when external_ref is actually set, so the existing
-- source='manual'/external_ref=NULL rows are entirely unaffected) turns "insert a billing_entries
-- row for this Stripe object id" into a safe insert-or-no-op: the webhook handler catches the
-- resulting unique-violation and treats it as "already recorded", rather than needing a
-- check-then-insert race window.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_entries_external_ref
  ON billing_entries(external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_entries_customer ON billing_entries(customer_id);

-- Links a booking to the account that was logged in at the moment of booking (src/functions/book.js).
-- Nullable and additive: every appointment created before this column existed, and every guest
-- booking made without a session afterward, simply has customer_id = NULL — booking never requires
-- an account, per the decision to keep guest checkout exactly as it works today.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_appointments_customer_id ON appointments(customer_id);

-- ============================================================================
-- Admin self-service password reset (additive only). ADMIN_PASSWORD used to be a static Azure App
-- Setting the running app could read but never write — there was no way for the app itself to let
-- Diaka change her own password. Moving the credential into the DB fixes that.
--
-- This salon has exactly one admin operator, not a multi-admin-user system, so rather than a full
-- `admin_users` table this is a single fixed row (`id` pinned to 1 by the CHECK) holding the
-- registered login email + a hashed password. A dedicated table rather than reusing the generic
-- `settings` key-value store above: a hashed credential and its reset-token expiry logic want real
-- typed columns (TIMESTAMPTZ expiry, an actual unique-ish token_hash) rather than being packed into
-- a JSONB blob under a couple of settings keys, and keeping it structurally separate from `settings`
-- (which backs the Shopify integration scaffold — see that table's comment) means nothing that
-- iterates `settings` rows for display ever has to know to skip a password hash.
CREATE TABLE IF NOT EXISTS admin_account (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- enforced single row: one admin operator
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,  -- crypto.scrypt, see lib/adminAuth.js hashPassword()/verifyPassword()
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per requested admin password-reset link. Kept separate from `auth_challenges` above
-- rather than reused: auth_challenges is keyed to a customer_id and a method in ('email','sms'),
-- and every piece of code that touches it (src/functions/auth/auth.js) assumes "this row is about a
-- customer." There's exactly one admin identity with no customer_id to hang a challenge off of, so
-- a small table of its own is clearer than teaching auth_challenges about a second, unrelated kind
-- of principal. Same "never store the raw secret" discipline as auth_challenges.secret_hash: only
-- `token_hash` (SHA-256 of the raw reset token) is stored, via lib/adminAuth.js's
-- hashResetToken()/resetTokenMatches().
CREATE TABLE IF NOT EXISTS admin_password_resets (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_password_resets_lookup ON admin_password_resets(used_at, expires_at);

-- ============================================================================
-- Inspiration-photo upload (additive only). Customers can optionally attach a photo of the hairstyle
-- they want when booking (book.html's contact-info step) via
-- src/functions/uploadInspirationPhoto.js, which uploads it to a dedicated private
-- 'inspiration-photos' blob container (infra/main.bicep) and returns a SAS-signed read URL; that URL
-- (if any) is attached to the new appointment row by src/functions/book.js at insert time. Nullable --
-- guest bookings and photo-less bookings are completely unaffected, same as every other additive
-- column in this file. See the task report for the flagged blob-retention/cleanup consideration this
-- implies (nothing here automatically deletes the underlying blob).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS inspiration_photo_url TEXT;

-- ============================================================================
-- Client profiles & notes (additive only). Diaka's daily "what do I need to know
-- about this person walking into their next visit" need: a handful of current-state
-- profile fields on customers (what's true about their hair right now), plus a
-- separate running timeline of free-text notes she can jot after any appointment
-- (how a past service turned out, allergy/sensitivity flags, styling preferences
-- observed in person, etc). Deliberately free-text/no enums or lookup tables — this
-- is a small single-operator salon, not built for rigid taxonomy. Staff-only: the
-- only code that reads or writes any of this is src/functions/admin/clients.js,
-- gated by requireAdmin() same as every other src/functions/admin/*.js file; it is
-- never exposed through /api/account/* or any other customer-facing endpoint, since
-- some notes may record sensitive things (health/allergy flags, or plainly "difficult
-- client") a stylist wants recorded privately, never shown to the customer themselves.
-- ============================================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS hair_type TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS hair_texture TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS allergies TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferences TEXT;

-- One row per note. Distinct from the current-state columns above: this is a log,
-- newest-first when displayed, not a "what's true now" snapshot. `appointment_id` is
-- nullable — a note doesn't always tie to a specific visit (e.g. something Diaka
-- wants to remember from a phone call or a walk-in chat). `created_by` is hardcoded
-- 'admin' at insert time, matching the single-admin-operator pattern already used by
-- billing_entries.recorded_by and admin_account above.
CREATE TABLE IF NOT EXISTS client_notes (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id),
  note TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_notes_customer ON client_notes(customer_id, created_at DESC);

-- ============================================================================
-- Rate limiting (additive only, added by the same security-audit pass that added
-- admin_account.session_epoch below). Azure Functions on a consumption plan can scale out to
-- multiple concurrent instances, so an in-process counter (a plain JS Map, a closure variable, etc.)
-- would not reliably throttle anything -- two requests routed to two different instances would each
-- see their own empty counter and both sail straight through. A table every instance reads/writes
-- through the same DATABASE_URL is the only throttle that actually holds across instances.
--
-- One row per attempt, not one row per (bucket, identifier) with a running count -- that's what lets
-- the window slide continuously (`created_at > now() - interval`, see lib/rateLimit.js) with zero
-- periodic reset/cleanup job: an old row simply stops counting toward any future COUNT(*) the moment
-- it ages out of the window on its own. Nothing here ever deletes old rows automatically, so this
-- table grows unboundedly over time -- flagged in the task report as a someday operational follow-up
-- (a scheduled DELETE of rows past the longest window in use), not a launch blocker at this salon's
-- traffic volume.
--
-- `bucket` names the endpoint/limiter being protected ('admin_login', 'otp_request',
-- 'admin_reset_request', 'style_suggest', 'upload_inspiration_photo' -- see lib/rateLimit.js's callers
-- in src/functions/). `identifier` is whatever's actually being throttled, always prefixed with its
-- kind (`ip:1.2.3.4`, `target:someone@example.com`) so two different kinds of identifier can never
-- collide inside the same bucket -- several limiters key by BOTH the caller's IP and the specific
-- victim identifier being targeted at once (e.g. an OTP-request flood aimed at one phone number,
-- spread across many attacker-controlled IPs, is still caught by the target: check even though no
-- single IP ever crosses its own, looser threshold).
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id SERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  identifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_lookup ON rate_limit_events(bucket, identifier, created_at);

-- ============================================================================
-- Admin session revocation (additive only). Resetting the admin password used to leave any
-- already-issued session cookie valid for its full 12-hour TTL (lib/adminAuth.js SESSION_TTL_MS) even
-- though a password reset is often exactly the response to a stolen/compromised session -- the one
-- scenario where invalidating outstanding sessions matters most. `session_epoch` is embedded in every
-- session cookie at sign time (lib/adminAuth.js signSession(), called from
-- src/functions/admin/login.js with the row's *current* value) and re-checked against the row's
-- *current* value on every verification (lib/adminAuth.js verifySession(), via requireAdmin()) --
-- a cookie whose embedded epoch doesn't match is rejected exactly like an expired or tampered one.
-- src/functions/admin/passwordReset.js's reset-password handler increments this column in the same
-- UPDATE that changes password_hash, so one row update instantly invalidates every previously-issued
-- session with no separate session-store/blocklist needed -- there's only ever one admin identity, so
-- one integer that only ever moves forward is enough to represent "everything issued before now is
-- stale."
ALTER TABLE admin_account ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 1;
