// Unit tests for lib/email.js's buildMessages() — the pure, no-I/O message-building logic behind
// sendBookingConfirmations(). Exercised directly (buildMessages is exported for exactly this reason)
// rather than mocking the @azure/communication-email SDK, same spirit as src/functions/book.js
// exporting validateBody()/inspirationPhotoUrlPrefix() for direct unit testing instead of exercising
// them only through the full HTTP handler.
//
// Focus: the guest-account CTA line added to the customer-facing confirmation email (added for the
// "guest never learns they could have an account" gap — see book.html's matching in-page CTA and
// src/functions/auth/auth.js's retroactive-linking feature it points toward). Everything else about
// buildMessages (subject lines, the manage/cancel link, the business-notification email's fields) is
// pre-existing and untouched by this change, so it isn't re-verified here.
//
// Run with: node test/email.test.js
'use strict';

const assert = require('assert');
const { buildMessages } = require('../lib/email');

function baseAppointment(overrides) {
  return Object.assign(
    {
      id: 1,
      service_id: 1,
      customer_name: 'Jamie Customer',
      customer_phone: '2675550100',
      customer_email: 'Jamie@Example.com',
      notes: null,
      start_at: '2027-06-01T14:00:00.000Z',
      sms_opt_in: false,
      sms_phone: null,
      manage_token: 'abc123manage',
      customer_id: null,
    },
    overrides
  );
}

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  process.env.ACS_EMAIL_FROM_ADDRESS = 'DoNotReply@test.azurecomm.net';
  process.env.SITE_BASE_URL = 'https://example.test';
  delete process.env.BUSINESS_NOTIFY_EMAIL;

  await test('guest booking (customer_id null) — customer email includes the create-account CTA, linking to account.html with the booking email pre-filled', () => {
    const [customerMessage] = buildMessages(baseAppointment({ customer_id: null }), { name: 'Braids' });
    const text = customerMessage.content.plainText;
    assert.ok(/Create a free account/.test(text), 'expected the CTA line to be present');
    assert.ok(
      text.includes('https://example.test/account.html?email=Jamie%40Example.com'),
      'expected the account.html link with the exact (encoded, un-lowercased) booking email'
    );
  });

  await test('logged-in booking (customer_id set) — no CTA line at all', () => {
    const [customerMessage] = buildMessages(baseAppointment({ customer_id: 42 }), { name: 'Braids' });
    const text = customerMessage.content.plainText;
    assert.ok(!/Create a free account/.test(text));
    assert.ok(!text.includes('account.html'));
  });

  await test('the CTA does not disturb the existing manage/cancel link or sign-off', () => {
    const [customerMessage] = buildMessages(baseAppointment({ customer_id: null }), { name: 'Braids' });
    const text = customerMessage.content.plainText;
    assert.ok(text.includes('https://example.test/book.html?manage=abc123manage'));
    assert.ok(text.includes('AFRIKANADOLLZ — 281 S 52nd St, Philadelphia, PA 19139'));
  });

  await test('business notification email never includes the CTA, guest booking or not', () => {
    process.env.BUSINESS_NOTIFY_EMAIL = 'diaka@example.com';
    try {
      const guestMessages = buildMessages(baseAppointment({ customer_id: null }), { name: 'Braids' });
      const loggedInMessages = buildMessages(baseAppointment({ customer_id: 7 }), { name: 'Braids' });
      assert.strictEqual(guestMessages.length, 2);
      assert.strictEqual(loggedInMessages.length, 2);
      assert.ok(!/account\.html/.test(guestMessages[1].content.plainText));
      assert.ok(!/account\.html/.test(loggedInMessages[1].content.plainText));
    } finally {
      delete process.env.BUSINESS_NOTIFY_EMAIL;
    }
  });

  await test('with no BUSINESS_NOTIFY_EMAIL configured, only the customer message is built (unchanged pre-existing behavior)', () => {
    const messages = buildMessages(baseAppointment({ customer_id: null }), { name: 'Braids' });
    assert.strictEqual(messages.length, 1);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
