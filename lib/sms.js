// Sends the 30-minutes-before-appointment SMS reminder via Azure Communication Services (ACS) SMS.
// Used by src/functions/sendReminders.js (timer trigger). Kept separate so it can be unit-tested
// with a mocked SmsClient.
//
// Unlike lib/email.js, a failed send here throws — src/functions/sendReminders.js relies on that to
// decide per-row whether to mark reminder_sent=true (only on success), so a transient SMS failure is
// retried on the next 5-minute run while the appointment is still inside the 25-35min window.
//
// PLACEHOLDER env vars — the user must fill these in once they provision an ACS resource with SMS
// enabled and a purchased phone number (see task report for the full checklist):
//   ACS_SMS_CONNECTION_STRING - from the ACS resource's "Keys" blade in the Azure Portal
//   ACS_SMS_FROM_NUMBER       - an SMS-capable phone number purchased on that resource, E.164
//                               format (e.g. "+15555550100")
'use strict';

const { SmsClient } = require('@azure/communication-sms');

let client;
function getClient() {
  if (client === undefined) {
    const conn = process.env.ACS_SMS_CONNECTION_STRING;
    client = conn ? new SmsClient(conn) : null;
  }
  return client;
}

// Exposed for tests: reset the memoized client so a differently-mocked env can be exercised.
function _resetClientForTests() {
  client = undefined;
}

/**
 * Send a single SMS reminder. Throws on any failure (network error, misconfiguration, or ACS
 * reporting the individual message as unsuccessful) — see file header for why that's intentional.
 * @param {string} toPhone - E.164 destination number.
 * @param {string} message - SMS body text.
 */
async function sendReminderSms(toPhone, message) {
  const smsClient = getClient();
  const fromNumber = process.env.ACS_SMS_FROM_NUMBER;
  if (!smsClient || !fromNumber) {
    throw new Error('ACS_SMS_CONNECTION_STRING/ACS_SMS_FROM_NUMBER not configured');
  }

  const [result] = await smsClient.send({ from: fromNumber, to: [toPhone], message });
  if (!result || !result.successful) {
    throw new Error(`SMS send failed: ${(result && result.errorMessage) || 'unknown error'}`);
  }
  return result;
}

/**
 * Send a customer-account sign-in OTP code. Added for the customer-accounts feature, alongside
 * sendReminderSms — same ACS SmsClient/getClient() plumbing and the same "throw on failure" policy
 * (see that function's header comment): a code the customer never received is useless, so the caller
 * (src/functions/auth/auth.js) needs to know the send failed rather than reporting success.
 *
 * NOT LIVE-TESTABLE YET: same caveat as sendReminderSms — ACS_SMS_FROM_NUMBER is still a placeholder
 * until a phone number is purchased and A2P 10DLC registration completes (see local.settings.json).
 * @param {string} toPhone - E.164 destination number.
 * @param {string} code - the OTP digits, as plain text (not yet hashed — hashing happens at rest in
 *   auth_challenges via lib/customerAuth.js's hashChallengeSecret, this is just what gets texted).
 */
async function sendOtpSms(toPhone, code) {
  const message = `Your AFRIKANADOLLZ sign-in code is ${code}. It expires in 10 minutes. Didn't request this? Ignore this text.`;
  return sendReminderSms(toPhone, message);
}

module.exports = { sendReminderSms, sendOtpSms, _resetClientForTests };
