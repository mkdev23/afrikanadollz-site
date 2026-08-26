// Timer trigger (step 4 of the plan): every 5 minutes, scans for confirmed, SMS-opted-in
// appointments starting in ~25-35 minutes that haven't been reminded yet, sends the SMS via Azure
// Communication Services SMS, and marks reminder_sent=true PER ROW as it succeeds (not batched) —
// so a mid-run crash can't double-send on retry, matching the plan's crash-safety reasoning for the
// original /api/cron/send-reminders endpoint. This replaces that cron-job.org-triggered HTTP
// endpoint entirely: a standalone/BYO Azure Function App supports timer triggers natively, so no
// external trigger service or CRON_SECRET is needed here (Static Web Apps' managed-Functions mode
// does NOT support timer triggers, which is exactly why this project uses a standalone Function App
// linked via "bring your own Functions" instead).
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { sendReminderSms } = require('../../lib/sms');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function formatWhen(startAt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(startAt));
}

async function sendRemindersHandler(myTimer, context) {
  if (myTimer && myTimer.isPastDue) {
    context.warn('sendReminders: timer invocation is running late');
  }

  const db = getPool();

  let rows;
  try {
    // Mirrors the plan's scan query exactly: status='confirmed' AND sms_opt_in AND NOT reminder_sent
    // AND start_at BETWEEN now()+25min AND now()+35min.
    const result = await db.query(
      `SELECT id, customer_name, sms_phone, start_at
       FROM appointments
       WHERE status = 'confirmed' AND sms_opt_in = true AND reminder_sent = false
         AND start_at BETWEEN now() + interval '25 minutes' AND now() + interval '35 minutes'`
    );
    rows = result.rows;
  } catch (err) {
    context.error('sendReminders: failed to scan for due appointments:', err);
    return;
  }

  for (const appt of rows) {
    try {
      const when = formatWhen(appt.start_at);
      await sendReminderSms(
        appt.sms_phone,
        `Hi ${appt.customer_name}, this is a reminder that your AFRIKANADOLLZ appointment is at ${when} (about 30 minutes from now). See you soon!`
      );
      // Marked immediately after this one send succeeds — not batched at the end of the loop — so a
      // crash partway through the run leaves already-sent rows correctly flagged and only re-attempts
      // the ones that weren't reached yet (still safely inside the 25-35min scan window next run).
      await db.query('UPDATE appointments SET reminder_sent = true WHERE id = $1', [appt.id]);
      context.log(`sendReminders: reminder sent for appointment ${appt.id}`);
    } catch (err) {
      context.error(`sendReminders: reminder failed for appointment ${appt.id}:`, err);
    }
  }
}

app.timer('sendReminders', {
  schedule: '0 */5 * * * *', // NCRONTAB: every 5 minutes
  handler: sendRemindersHandler,
});

module.exports = { sendRemindersHandler };
