// Shared phone-number normalization. Added alongside the retroactive guest-appointment-linking
// feature (src/functions/auth/auth.js's linkOrphanGuestAppointments) once it became clear that
// matching phone numbers by raw string equality doesn't work: the same real phone number gets typed
// in several different shapes across this app's various phone-entry points (book.html's booking
// form, account.html's sign-in form, admin.html's client search box) — "(267) 481-4058",
// "267-481-4058", "2674814058", "+12674814058" — and without a shared canonical form, two of those
// shapes for the very same number would never compare equal.
//
// Deliberately dependency-free (no libphonenumber or similar) — this codebase stays intentionally
// light on dependencies (see lib/adminAuth.js's header comment on the same principle for session
// auth), and this salon's customer base is overwhelmingly US phone numbers, so a full
// E.164/international parsing library would be a lot of weight for very little real benefit here.
//
// Strategy: strip everything but digits, then:
//   - exactly 10 digits            -> treat as a US number missing its country code, prefix "+1"
//   - 11 digits starting with "1"  -> treat as an already-country-coded US number, prefix "+"
//   - anything else (too short, too long, or an unrecognized digit count) -> just the bare digit
//     string, with no country-code guessing, so unusual/garbage input isn't silently turned into a
//     plausible-looking-but-wrong number
// This means "(267) 481-4058", "267-481-4058", "2674814058", and "+12674814058" all normalize to the
// same "+12674814058" and therefore compare equal wherever this helper is used consistently.
'use strict';

function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits;
}

module.exports = { normalizePhone };
