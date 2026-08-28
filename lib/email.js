// Sends the two booking-confirmation emails (customer + business) via Azure Communication Services
// (ACS) Email. Kept separate from src/functions/book.js so it can be unit-tested with a mocked
// EmailClient, same spirit as lib/availability.js being separated from the HTTP layer.
//
// Failure-tolerant per the plan: any send error is logged and swallowed, never thrown — the
// appointment row is already committed by the time this runs, so it remains the source of truth
// regardless of whether either email actually lands.
//
// PLACEHOLDER env vars — the user must fill these in once they provision an ACS resource with an
// Email Communication Resource + a verified sending domain (see task report for the full checklist):
//   ACS_EMAIL_CONNECTION_STRING - from the ACS resource's "Keys" blade in the Azure Portal
//   ACS_EMAIL_FROM_ADDRESS      - a sender address on that resource's verified domain, e.g.
//                                 "DoNotReply@<verified-domain>.azurecomm.net" (ACS-managed domain)
//                                 or a custom domain once DNS verification completes
//   BUSINESS_NOTIFY_EMAIL       - the salon's inbox that should receive new-booking notifications
//                                 (Diaka's real inbox — not published anywhere on the site; the user
//                                 must provide it)
//   SITE_BASE_URL               - the live site's origin, used to build the manage/cancel link
'use strict';

const { EmailClient } = require('@azure/communication-email');

let client;
function getClient() {
  if (client === undefined) {
    const conn = process.env.ACS_EMAIL_CONNECTION_STRING;
    client = conn ? new EmailClient(conn) : null;
  }
  return client;
}

// Exposed for tests: reset the memoized client so a differently-mocked env can be exercised.
function _resetClientForTests() {
  client = undefined;
}

function formatWhen(startAt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(startAt));
}

function buildMessages(appointment, service) {
  const fromAddress = process.env.ACS_EMAIL_FROM_ADDRESS;
  const businessEmail = process.env.BUSINESS_NOTIFY_EMAIL;
  const when = formatWhen(appointment.start_at);
  const siteBase = process.env.SITE_BASE_URL || 'https://afrikanadollz.com';
  const manageUrl = `${siteBase}/book.html?manage=${appointment.manage_token}`;
  const serviceName = service ? service.name : `service #${appointment.service_id}`;

  // Guest-account CTA (added for the "guest never learns they could have an account" gap — see
  // book.html's confirmation screen for the matching in-page CTA, shown/sent under the exact same
  // condition: only when nobody was signed in at booking time). appointment.customer_id is set by
  // src/functions/book.js's optionalCustomerId() at booking time — non-null means the person was
  // already signed in and already has an account, so there's nothing to invite them to. account.html
  // reads the `email` query param to pre-select the email tab and pre-fill it (see account.html's
  // boot script), so a guest tapping this link from their inbox never has to retype what they just
  // gave the salon. customer_email is always populated (guest or not — required at booking), so this
  // is always safe to build.
  const accountUrl = `${siteBase}/account.html?email=${encodeURIComponent(appointment.customer_email)}`;
  const guestAccountLine = appointment.customer_id
    ? ''
    : `Want to track this appointment, see your billing, and save your hair profile for next time? Create a free account:\n${accountUrl}\n\n`;

  const customerMessage = {
    senderAddress: fromAddress,
    content: {
      subject: 'Your appointment is confirmed — AFRIKANADOLLZ',
      plainText:
        `Hi ${appointment.customer_name},\n\n` +
        `Your appointment for ${serviceName} is confirmed for ${when}.\n\n` +
        `Need to cancel or reschedule? Manage your appointment here:\n${manageUrl}\n\n` +
        guestAccountLine +
        `See you soon!\nAFRIKANADOLLZ — 281 S 52nd St, Philadelphia, PA 19139\n`,
    },
    recipients: { to: [{ address: appointment.customer_email, displayName: appointment.customer_name }] },
  };

  const businessMessage = businessEmail
    ? {
        senderAddress: fromAddress,
        content: {
          subject: `New booking: ${appointment.customer_name} — ${when}`,
          plainText:
            `New appointment booked.\n\n` +
            `Service: ${serviceName}\n` +
            `When: ${when}\n` +
            `Customer: ${appointment.customer_name}\n` +
            `Phone: ${appointment.customer_phone}\n` +
            `Email: ${appointment.customer_email}\n` +
            `Notes: ${appointment.notes || '(none)'}\n` +
            `SMS opt-in: ${appointment.sms_opt_in ? `yes (${appointment.sms_phone})` : 'no'}\n`,
        },
        recipients: { to: [{ address: businessEmail }] },
      }
    : null;

  return [customerMessage, businessMessage].filter(Boolean);
}

/**
 * Send the customer confirmation + business notification emails for a just-booked appointment.
 * Never throws — logs and continues on any failure, per the plan's log-not-fail policy.
 * @param {object} appointment - the inserted appointments row (customer_name, customer_email, etc).
 * @param {object|null} service - { name } of the booked service, for readable email copy.
 */
async function sendBookingConfirmations(appointment, service) {
  const emailClient = getClient();
  const fromAddress = process.env.ACS_EMAIL_FROM_ADDRESS;

  if (!emailClient || !fromAddress) {
    console.warn(
      'sendBookingConfirmations: ACS_EMAIL_CONNECTION_STRING/ACS_EMAIL_FROM_ADDRESS not configured — skipping confirmation emails.'
    );
    return;
  }

  const messages = buildMessages(appointment, service);

  await Promise.all(
    messages.map(async (message) => {
      try {
        const poller = await emailClient.beginSend(message);
        await poller.pollUntilDone();
      } catch (err) {
        console.error('Confirmation email send failed (booking still stands):', err);
      }
    })
  );
}

/**
 * Send a customer-account sign-in (magic-link) email. Added for the customer-accounts feature,
 * alongside sendBookingConfirmations — same ACS EmailClient, same getClient()/_resetClientForTests()
 * plumbing, but a DIFFERENT failure policy: sendBookingConfirmations never throws because the
 * appointment it's about is already committed by the time it runs (the email is a courtesy). Here
 * there's no fallback — if this send fails, the customer has no way to sign in — so this throws on
 * any failure and src/functions/auth/auth.js turns that into a 500 the caller can retry, instead of
 * silently reporting success for a code that was never delivered.
 * @param {string} toEmail
 * @param {string} magicLinkUrl - lands the customer back on account.html with ?token=... to auto-verify
 */
async function sendMagicLinkEmail(toEmail, magicLinkUrl) {
  const emailClient = getClient();
  const fromAddress = process.env.ACS_EMAIL_FROM_ADDRESS;
  if (!emailClient || !fromAddress) {
    throw new Error('ACS_EMAIL_CONNECTION_STRING/ACS_EMAIL_FROM_ADDRESS not configured');
  }

  const message = {
    senderAddress: fromAddress,
    content: {
      subject: 'Your AFRIKANADOLLZ sign-in link',
      plainText:
        `Tap the link below to sign in to your AFRIKANADOLLZ account.\n\n${magicLinkUrl}\n\n` +
        `This link expires in 15 minutes and works once. Didn't request this? You can safely ignore this email.\n`,
    },
    recipients: { to: [{ address: toEmail }] },
  };

  const poller = await emailClient.beginSend(message);
  await poller.pollUntilDone();
}

/**
 * Send an admin password-reset email. Added alongside sendMagicLinkEmail for the admin
 * self-service password-reset feature — same ACS EmailClient plumbing, same "throw on failure"
 * policy as sendMagicLinkEmail (there's no fallback delivery path for a reset link either), but the
 * caller (src/functions/admin/passwordReset.js) catches and swallows that error rather than letting
 * it surface as a 500: the request-password-reset endpoint must always return a generic success
 * response regardless of whether the email matched OR whether delivery actually succeeded, so it
 * can't leak either fact to the caller.
 * @param {string} toEmail
 * @param {string} resetUrl - lands the admin back on admin.html with ?resetToken=... to set a new password
 */
async function sendAdminPasswordResetEmail(toEmail, resetUrl) {
  const emailClient = getClient();
  const fromAddress = process.env.ACS_EMAIL_FROM_ADDRESS;
  if (!emailClient || !fromAddress) {
    throw new Error('ACS_EMAIL_CONNECTION_STRING/ACS_EMAIL_FROM_ADDRESS not configured');
  }

  const message = {
    senderAddress: fromAddress,
    content: {
      subject: 'Reset your AFRIKANADOLLZ admin password',
      plainText:
        `Tap the link below to set a new AFRIKANADOLLZ admin password.\n\n${resetUrl}\n\n` +
        `This link expires in 15 minutes and works once. Didn't request this? You can safely ignore this email.\n`,
    },
    recipients: { to: [{ address: toEmail }] },
  };

  const poller = await emailClient.beginSend(message);
  await poller.pollUntilDone();
}

// Human-readable labels for custom_wig_orders.lace_style, shared by the customer + business messages
// below. Kept here rather than duplicated inline twice.
const LACE_STYLE_LABEL = {
  precut: 'Pre-cut lace',
  uncut: 'Uncut lace',
  unsure: 'Not sure yet -- wants guidance',
};

const MEASUREMENT_LABELS = [
  ['circumference_in', 'Circumference'],
  ['front_to_nape_in', 'Front to nape'],
  ['ear_to_ear_forehead_in', 'Ear to ear (across forehead)'],
  ['ear_to_ear_top_in', 'Ear to ear (over the top)'],
  ['temple_to_temple_in', 'Temple to temple (round the back)'],
  ['nape_of_neck_in', 'Nape of neck'],
];

function formatMeasurementLines(order) {
  return MEASUREMENT_LABELS
    .filter(([col]) => order[col] !== null && order[col] !== undefined)
    .map(([col, label]) => `  ${label}: ${order[col]}"`);
}

/**
 * Builds the two custom-wig-order emails (customer confirmation + business notification), same
 * shape/reasoning as buildMessages() above -- pure and exported for direct unit testing rather than
 * exercising it only through the full send path.
 * @param {object} order - the inserted custom_wig_orders row.
 */
function buildCustomWigOrderMessages(order) {
  const fromAddress = process.env.ACS_EMAIL_FROM_ADDRESS;
  const businessEmail = process.env.BUSINESS_NOTIFY_EMAIL;
  const laceLabel = LACE_STYLE_LABEL[order.lace_style] || order.lace_style;
  const measurementLines = formatMeasurementLines(order);
  const hasSizingInfo = Boolean(order.cap_size) || measurementLines.length > 0;

  const customerMessage = {
    senderAddress: fromAddress,
    content: {
      subject: 'Your custom wig order has been received — AFRIKANADOLLZ',
      plainText:
        `Hi ${order.customer_name},\n\n` +
        `Thank you for starting a custom wig order with AFRIKANADOLLZ! Here's what we received:\n\n` +
        `Lace style: ${laceLabel}\n` +
        (order.cap_size ? `Cap size: ${order.cap_size}\n` : '') +
        (measurementLines.length ? `Measurements:\n${measurementLines.join('\n')}\n` : '') +
        (order.style_notes ? `Style notes: ${order.style_notes}\n` : '') +
        `\nWe'll follow up to confirm details, pricing and timeline.` +
        (hasSizingInfo ? '' : ` Haven't measured your head yet? No problem — we can walk you through it when we reach out.`) +
        `\n\nQuestions in the meantime? Call or text (267) 481-4058.\n\n` +
        `AFRIKANADOLLZ — 281 S 52nd St, Philadelphia, PA 19139\n`,
    },
    recipients: { to: [{ address: order.customer_email, displayName: order.customer_name }] },
  };

  const businessMessage = businessEmail
    ? {
        senderAddress: fromAddress,
        content: {
          subject: `New custom wig order: ${order.customer_name}`,
          plainText:
            `New custom wig order received.\n\n` +
            `Customer: ${order.customer_name}\n` +
            `Phone: ${order.customer_phone}\n` +
            `Email: ${order.customer_email}\n` +
            `Lace style: ${laceLabel}\n` +
            `Cap size: ${order.cap_size || '(not given)'}\n` +
            `Measurements:\n${measurementLines.length ? measurementLines.join('\n') : '  (none given)'}\n` +
            `Style notes: ${order.style_notes || '(none)'}\n` +
            `Reference photo: ${order.reference_photo_url || '(none)'}\n`,
        },
        recipients: { to: [{ address: businessEmail }] },
      }
    : null;

  return [customerMessage, businessMessage].filter(Boolean);
}

/**
 * Send the customer confirmation + business notification emails for a just-submitted custom wig
 * order. Same log-not-fail policy as sendBookingConfirmations -- the order row is already committed
 * by the time this runs, so a delivery failure here can never turn a successful order into an error
 * response.
 * @param {object} order - the inserted custom_wig_orders row.
 */
async function sendCustomWigOrderConfirmations(order) {
  const emailClient = getClient();
  const fromAddress = process.env.ACS_EMAIL_FROM_ADDRESS;

  if (!emailClient || !fromAddress) {
    console.warn(
      'sendCustomWigOrderConfirmations: ACS_EMAIL_CONNECTION_STRING/ACS_EMAIL_FROM_ADDRESS not configured — skipping confirmation emails.'
    );
    return;
  }

  const messages = buildCustomWigOrderMessages(order);

  await Promise.all(
    messages.map(async (message) => {
      try {
        const poller = await emailClient.beginSend(message);
        await poller.pollUntilDone();
      } catch (err) {
        console.error('Custom wig order confirmation email send failed (order still stands):', err);
      }
    })
  );
}

module.exports = {
  sendBookingConfirmations,
  sendMagicLinkEmail,
  sendAdminPasswordResetEmail,
  sendCustomWigOrderConfirmations,
  buildMessages,
  buildCustomWigOrderMessages,
  _resetClientForTests,
};
