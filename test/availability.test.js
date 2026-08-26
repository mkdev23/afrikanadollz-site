// Unit tests for lib/availability.js's computeSlots() — the pure slot-computation function shared by
// GET /api/availability (src/functions/availability.js) and the booking-time re-validation inside
// POST /api/book (src/functions/book.js). No DB/HTTP involved (pure function), so these run with
// plain Node, same "node --check + node test/foo.test.js" discipline as the rest of this session.
//
// computeSlots() offers ROLLING start times (a candidate every `granularityMin` minutes, default
// DEFAULT_SLOT_GRANULARITY_MIN = 30) rather than fixed non-overlapping duration-sized blocks. These
// tests cover: the rolling-density behavior itself, buffer interactions (both against existing
// appointments AND against the window's closing time), overlap exclusion at a rolling offset (not
// just at duration-aligned boundaries), and the pre-existing DST-transition correctness of
// zonedWallTimeToUtc via computeSlots' day-window math.
//
// Run with: node test/availability.test.js
'use strict';

const assert = require('assert');
const { computeSlots, zonedWallTimeToUtc, weekdayOf, DEFAULT_SLOT_GRANULARITY_MIN } = require('../lib/availability');

const TIMEZONE = 'America/New_York';

function rule(weekday, startTime, endTime) {
  return { weekday, start_time: startTime, end_time: endTime };
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

  // A fixed future Tuesday (2027 is used elsewhere in this repo's tests as a safely-future working
  // year, well past "today" regardless of when this test runs).
  const YEAR = 2027, MONTH = 6, DAY = 1; // 2027-06-01, a Tuesday
  const WEEKDAY = weekdayOf(YEAR, MONTH, DAY);
  const DATE_STR = '2027-06-01';

  await test('default granularity constant is 30 minutes', () => {
    assert.strictEqual(DEFAULT_SLOT_GRANULARITY_MIN, 30);
  });

  await test('rolling start times: a 240-minute service in a 10:00-18:00 window offers a start every 30 min, not just two fixed blocks', () => {
    const rules = [rule(WEEKDAY, '10:00:00', '18:00:00')];
    const [day] = computeSlots(rules, [], [], 240, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE);

    // Old fixed-block behavior returned exactly 2 slots (10:00-14:00, 14:00-18:00). With 30-minute
    // rolling starts, the last bookable start is 14:00 (14:00 + 240min = 18:00, the window close),
    // so starts run 10:00, 10:30, 11:00, ..., 14:00 -> (14:00-10:00)/30min + 1 = 9 slots.
    assert.strictEqual(day.slots.length, 9);

    const expectedStarts = [
      '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00',
    ];
    const actualStarts = day.slots.map((s) => {
      const utc = new Date(s.start);
      // Render back in the salon's local time for a readable assertion.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      const parts = {};
      for (const p of fmt.formatToParts(utc)) parts[p.type] = p.value;
      return `${parts.hour}:${parts.minute}`;
    });
    assert.deepStrictEqual(actualStarts, expectedStarts);

    // Every slot is still exactly a 240-minute (4 hour) appointment.
    for (const s of day.slots) {
      const durMin = (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000;
      assert.strictEqual(durMin, 240);
    }

    // First slot starts exactly at window open; last slot ends exactly at window close.
    assert.strictEqual(day.slots[0].start, zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE).toISOString());
    const last = day.slots[day.slots.length - 1];
    assert.strictEqual(last.end, zonedWallTimeToUtc(YEAR, MONTH, DAY, 18, 0, TIMEZONE).toISOString());
  });

  await test('a custom granularityMin overrides the default spacing', () => {
    const rules = [rule(WEEKDAY, '09:00:00', '10:00:00')];
    // 15-minute service, 15-minute granularity, 1-hour window, no buffer: starts at 09:00, 09:15,
    // 09:30, 09:45 (09:45 + 15min = 10:00, exactly window close) -> 4 slots.
    const [day] = computeSlots(rules, [], [], 15, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE, 15);
    assert.strictEqual(day.slots.length, 4);
  });

  await test('buffer_min must also fit before the window closes (not just the service duration)', () => {
    const rules = [rule(WEEKDAY, '09:00:00', '10:00:00')];
    // 30-minute service, 30-minute granularity, 1-hour window, 15-minute buffer required after.
    // Candidate starts (ignoring buffer) would be 09:00 and 09:30, but 09:30 + 30min service +
    // 15min buffer = 10:15 > 10:00 close, so only 09:00 qualifies.
    const [day] = computeSlots(rules, [], [], 30, 15, { from: DATE_STR, to: DATE_STR }, TIMEZONE, 30);
    assert.strictEqual(day.slots.length, 1);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = {};
    for (const p of fmt.formatToParts(new Date(day.slots[0].start))) parts[p.type] = p.value;
    assert.strictEqual(`${parts.hour}:${parts.minute}`, '09:00');
  });

  await test('a rolling-offset candidate that overlaps an existing appointment is excluded, even though it is not duration-aligned', () => {
    const rules = [rule(WEEKDAY, '09:00:00', '12:00:00')];
    // 60-minute service, default 30-min granularity: candidates at 09:00, 09:30, 10:00, 10:30, 11:00.
    // An existing confirmed appointment 10:00-10:45 (no extra buffer here) should block any candidate
    // whose [start, start+60min) overlaps [10:00, 10:45): that's 09:30 (09:30-10:30 overlaps),
    // 10:00 (10:00-11:00 overlaps), and 10:30 (10:30-11:30 overlaps). 09:00 (09:00-10:00, ends exactly
    // at 10:00) and 11:00 (11:00-12:00, starts exactly at 10:45's implied end... wait buffer=0 so
    // 10:45 is free) should remain.
    const existing = [{
      start_at: zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE).toISOString(),
      end_at: zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 45, TIMEZONE).toISOString(),
    }];
    const [day] = computeSlots(rules, [], existing, 60, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE);

    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const starts = day.slots.map((s) => {
      const parts = {};
      for (const p of fmt.formatToParts(new Date(s.start))) parts[p.type] = p.value;
      return `${parts.hour}:${parts.minute}`;
    });
    assert.deepStrictEqual(starts, ['09:00', '11:00']);
  });

  await test('existing appointment busy window is extended by the REQUESTED service buffer, excluding rolling candidates within that runway', () => {
    const rules = [rule(WEEKDAY, '09:00:00', '12:00:00')];
    // Same appointment as above (10:00-10:45), but this time the requested service has a 30-minute
    // buffer, so the appointment's busy window effectively becomes [10:00, 11:15). Candidate 11:00
    // (11:00-12:00) now overlaps that extended busy window and should be excluded too, leaving only 09:00.
    const existing = [{
      start_at: zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE).toISOString(),
      end_at: zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 45, TIMEZONE).toISOString(),
    }];
    const [day] = computeSlots(rules, [], existing, 60, 30, { from: DATE_STR, to: DATE_STR }, TIMEZONE);

    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const starts = day.slots.map((s) => {
      const parts = {};
      for (const p of fmt.formatToParts(new Date(s.start))) parts[p.type] = p.value;
      return `${parts.hour}:${parts.minute}`;
    });
    assert.deepStrictEqual(starts, ['09:00']);
  });

  await test('a blocked_slot excludes overlapping rolling candidates the same way an appointment does', () => {
    const rules = [rule(WEEKDAY, '09:00:00', '11:00:00')];
    const blocks = [{
      start_at: zonedWallTimeToUtc(YEAR, MONTH, DAY, 9, 30, TIMEZONE).toISOString(),
      end_at: zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 0, TIMEZONE).toISOString(),
    }];
    // 30-minute service, default 30-min granularity: candidates 09:00, 09:30, 10:00, 10:30.
    // 09:30-10:00 is exactly the blocked range -> excluded. Others are clear.
    const [day] = computeSlots(rules, blocks, [], 30, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const starts = day.slots.map((s) => {
      const parts = {};
      for (const p of fmt.formatToParts(new Date(s.start))) parts[p.type] = p.value;
      return `${parts.hour}:${parts.minute}`;
    });
    assert.deepStrictEqual(starts, ['09:00', '10:00', '10:30']);
  });

  await test('no slots when the service (even alone, ignoring buffer) cannot fit in the window at all', () => {
    const rules = [rule(WEEKDAY, '09:00:00', '09:30:00')];
    const [day] = computeSlots(rules, [], [], 60, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE);
    assert.deepStrictEqual(day.slots, []);
  });

  await test('a day with no matching weekday rule returns an empty slots array, not an error', () => {
    const otherWeekday = (WEEKDAY + 1) % 7;
    const rules = [rule(otherWeekday, '09:00:00', '17:00:00')];
    const [day] = computeSlots(rules, [], [], 30, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE);
    assert.deepStrictEqual(day.slots, []);
  });

  await test('exact-boundary slot still matches a booking re-validation lookup (book.js contract)', () => {
    // src/functions/book.js re-runs computeSlots for the single requested day and does an EXACT
    // string match of a specific {start, end} pair against the freshly computed slot list. This
    // guards that contract still holds under rolling starts: a slot's start/end must be exact
    // ISO instants reproducible from the same inputs, not e.g. rounded or duration-only.
    const rules = [rule(WEEKDAY, '09:00:00', '17:00:00')];
    const [day] = computeSlots(rules, [], [], 60, 0, { from: DATE_STR, to: DATE_STR }, TIMEZONE);
    const requestedStart = zonedWallTimeToUtc(YEAR, MONTH, DAY, 10, 30, TIMEZONE);
    const requestedEnd = new Date(requestedStart.getTime() + 60 * 60000);
    const found = day.slots.some(
      (s) => s.start === requestedStart.toISOString() && s.end === requestedEnd.toISOString()
    );
    assert.ok(found, 'expected a rolling 30-minute-aligned candidate at 10:30 to be offered');
  });

  // --- DST-transition cases (pre-existing timezone-conversion correctness; unaffected by the
  // rolling-start-time change, but re-verified here through computeSlots' day-window math with
  // recalculated slot-count expectations for the new granularity). ---

  await test('DST spring-forward (2027-03-14, America/New_York loses the 2:00-3:00 AM hour): a window entirely after 3 AM is unaffected', () => {
    // 2027-03-14 is a Sunday; use a rule on that weekday, window 09:00-11:00 local, well clear of
    // the 2-3 AM transition, to confirm the day's wall-clock hours still resolve correctly and the
    // rolling-slot count matches a normal (non-DST) 2-hour window.
    const springYear = 2027, springMonth = 3, springDay = 14;
    const springWeekday = weekdayOf(springYear, springMonth, springDay);
    const rules = [rule(springWeekday, '09:00:00', '11:00:00')];
    const [day] = computeSlots(rules, [], [], 60, 0, { from: '2027-03-14', to: '2027-03-14' }, TIMEZONE);
    // 60-min service, 30-min granularity, 2-hour window: starts 09:00, 09:30, 10:00 (10:00+60=11:00 close) -> 3.
    assert.strictEqual(day.slots.length, 3);
    // The wall-clock span between first slot start and last slot end must be exactly 2 real hours
    // even though the US clock skipped an hour that same night at 2 AM (this window is after that,
    // so the elapsed real-world duration equals the nominal wall-clock duration here).
    const first = new Date(day.slots[0].start).getTime();
    const last = new Date(day.slots[day.slots.length - 1].end).getTime();
    assert.strictEqual(last - first, 2 * 60 * 60000);
  });

  await test('DST fall-back (2027-11-07, America/New_York repeats the 1:00-2:00 AM hour): a window entirely after 2 AM is unaffected', () => {
    const fallYear = 2027, fallMonth = 11, fallDay = 7;
    const fallWeekday = weekdayOf(fallYear, fallMonth, fallDay);
    const rules = [rule(fallWeekday, '09:00:00', '11:00:00')];
    const [day] = computeSlots(rules, [], [], 60, 0, { from: '2027-11-07', to: '2027-11-07' }, TIMEZONE);
    assert.strictEqual(day.slots.length, 3);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
