// Postgres-backed rate limiting, added ahead of card payments going live per the security audit that
// found no throttling anywhere in this codebase. Azure Functions on a consumption plan can scale out
// to multiple concurrent instances, so an in-process counter (a plain JS Map, a closure variable,
// etc.) would not reliably throttle anything -- two requests landing on two different instances would
// each see their own empty counter and both sail straight through. A table every instance reads/writes
// through the same DATABASE_URL is the only throttle that actually holds across instances, so this
// reuses the project's existing Postgres-centric approach (see lib/adminAuth.js, lib/customerAuth.js)
// rather than reaching for Redis or an Azure-specific throttling service just for this.
//
// See db/schema.sql's rate_limit_events table comment for the storage shape (one row per attempt, so
// the window slides continuously with zero reset/cleanup job) and the `ip:`/`target:` identifier-
// prefixing convention used by callers below.
'use strict';

/**
 * Best-effort extraction of the caller's IP from Azure Functions v4's `request.headers`. Azure
 * Static Web Apps / the Functions consumption plan sits behind a proxy chain, so the real client IP
 * arrives (if at all) via `x-forwarded-for` as a comma-separated list (`client, proxy1, proxy2, ...`)
 * -- only the FIRST entry is the original caller; anything after it was appended by a hop closer to
 * us and must never be trusted as "the caller's IP" (a malicious client could otherwise just prepend
 * whatever IP it wants to spoof). Azure commonly appends a `:port` suffix to a plain IPv4 entry
 * (`1.2.3.4:54321`) but not to IPv6 entries, so the port is only stripped when what's left afterward
 * still looks like a plain IPv4 address -- an IPv6 address (which itself contains colons) is left
 * untouched rather than mangled by a naive "split on the last colon".
 *
 * FLAGGED (see task report): the exact header shape actually presented by the real deployed Azure
 * Functions/Static Web Apps proxy chain -- whether it's really `x-forwarded-for`, whether the `:port`
 * suffix is always present -- can only be confirmed against that live infrastructure, not locally.
 * This never throws; a missing/unparseable header just falls back to the literal string 'unknown', so
 * a limiter can never crash a request over a missing IP. Worst case every un-attributable caller
 * shares one IP-keyed bucket, which is an availability trade-off (legitimate un-attributable callers
 * can rate-limit each other), not a security hole -- callers that also key by a target identifier
 * (see enforceRateLimit below) still enforce that check independently.
 * @param {import('@azure/functions').HttpRequest} request
 * @returns {string}
 */
function getClientIp(request) {
  try {
    const header = request.headers.get('x-forwarded-for');
    if (!header) return 'unknown';
    const first = header.split(',')[0].trim();
    if (!first) return 'unknown';
    const ipv4WithPort = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/.exec(first);
    return ipv4WithPort ? ipv4WithPort[1] : first;
  } catch {
    return 'unknown';
  }
}

/**
 * Checks a list of independent (bucket, identifier) rate-limit rules against rate_limit_events and,
 * regardless of the outcome, records this attempt against every one of them. Multiple checks in one
 * call exist because some limiters key by more than one identifier at once -- e.g. an OTP request is
 * capped both per-IP (loose, since a shared network like an office or campus NAT can have many
 * genuine callers) and per-target-identifier (tighter, since that's what actually stops a distributed
 * attacker rotating IPs to flood one victim's phone/email). Every check must be under its own
 * threshold for the attempt to be allowed.
 *
 * The attempt is always recorded, whether or not this call reports "blocked" and whether or not the
 * caller's underlying request goes on to succeed -- see db/schema.sql's rate_limit_events comment for
 * why: an attacker hammering an already-tripped limiter must not get a free pass to stop the window
 * from sliding forward just by being told no.
 *
 * @param {{query: Function}} db - a pg Pool (or anything with a compatible .query)
 * @param {{bucket: string, identifier: string, windowMs: number, maxAttempts: number}[]} checks
 * @returns {Promise<{bucket: string, identifier: string, retryAfterSeconds: number}|null>} the first
 *   exceeded check (enough to build a 429 from), or null if every check is currently under its limit.
 */
async function enforceRateLimit(db, checks) {
  let blocked = null;
  for (const check of checks) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM rate_limit_events
       WHERE bucket = $1 AND identifier = $2 AND created_at > now() - ($3 || ' milliseconds')::interval`,
      [check.bucket, check.identifier, check.windowMs]
    );
    const count = rows[0] ? rows[0].count : 0;
    if (!blocked && count >= check.maxAttempts) {
      blocked = {
        bucket: check.bucket,
        identifier: check.identifier,
        retryAfterSeconds: Math.ceil(check.windowMs / 1000),
      };
    }
  }
  for (const check of checks) {
    await db.query('INSERT INTO rate_limit_events (bucket, identifier) VALUES ($1, $2)', [check.bucket, check.identifier]);
  }
  return blocked;
}

/**
 * Builds the {status, jsonBody} for a tripped limiter. Shape mirrors this codebase's existing 429
 * (src/functions/auth/auth.js's OTP-attempt-cap response: `{status: 429, jsonBody: {error: string}}`)
 * with an added `retryAfterSeconds` so a caller like account.html/admin.html can disable a "resend"
 * button client-side without parsing the message text, plus a matching standard `Retry-After` response
 * header for anything that reads headers instead of the body. `message`, if given, overrides the
 * generic default so each handler can phrase the 429 in its own user-facing context (matching how this
 * codebase's other error strings are handler-specific, not one shared generic string).
 * @param {{retryAfterSeconds: number}} blocked - the object enforceRateLimit() returned
 * @param {string} [message]
 */
function rateLimitResponse(blocked, message) {
  return {
    status: 429,
    jsonBody: {
      error: message || 'Too many attempts. Please try again shortly.',
      retryAfterSeconds: blocked.retryAfterSeconds,
    },
    headers: { 'Retry-After': String(blocked.retryAfterSeconds) },
  };
}

module.exports = { getClientIp, enforceRateLimit, rateLimitResponse };
