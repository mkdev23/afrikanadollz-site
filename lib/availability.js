// Pure slot-computation logic for /api/availability.js. No DB/HTTP here on purpose, so it can be
// unit-tested with plain Node scripts (see db/../test files run during this task's verification).
'use strict';

/**
 * Resolve a local wall-clock time (as it would read on a clock in `timeZone`) to the UTC instant
 * it represents, correctly across DST transitions.
 *
 * Approach: Intl.DateTimeFormat with a `timeZone` option always uses the OS/ICU timezone database,
 * which already knows every historical and future DST rule for the zone (no external tz package
 * needed). We can't ask it "what UTC instant is 10:00 America/New_York on 2026-03-08" directly, so
 * instead we go the other way (an instant -> its local reading) and iterate to convergence: guess an
 * instant, see what it reads as in the target zone, and correct the guess by the difference. Two
 * iterations is enough even for the (rare) instant that lands inside a DST fall-back repeated hour.
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const targetAsUtcMillis = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetAsUtcMillis;
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMillisAt(guess, timeZone); // (local wall clock at `guess`) - guess
    guess = targetAsUtcMillis - offset;
  }
  return new Date(guess);
}

function tzOffsetMillisAt(instantMillis, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(instantMillis))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight even with h23
  const wallAsUtcMillis = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  return wallAsUtcMillis - instantMillis;
}

// Weekday (0=Sun..6=Sat) of a calendar date. Deliberately timezone-independent: a Y-M-D calendar
// date's day-of-week doesn't depend on which zone you're asking from.
function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseYmd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}

function formatYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function* eachDate(fromStr, toStr) {
  let { y, m, d } = parseYmd(fromStr);
  const to = parseYmd(toStr);
  const toKey = formatYmd(to.y, to.m, to.d);
  while (formatYmd(y, m, d) <= toKey) {
    yield { y, m, d };
    ({ y, m, d } = addDays(y, m, d, 1));
  }
}

function parseTimeOfDay(t) {
  // Postgres TIME comes back as 'HH:MM:SS' (or 'HH:MM'); take hour/minute only.
  const [hh, mm] = t.split(':').map(Number);
  return { hh, mm };
}

function toMillis(x) {
  return x instanceof Date ? x.getTime() : new Date(x).getTime();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Default spacing between candidate start times when none is passed to computeSlots(). 30 minutes
// matches typical salon booking granularity (Acuity/Calendly-style "rolling" start times) without
// overwhelming the picker with too many near-duplicate options. Callers (or tests) that want a finer
// or coarser grid can pass their own `granularityMin` argument instead of relying on this default —
// it's exported so the value lives in exactly one place rather than being hardcoded inline.
const DEFAULT_SLOT_GRANULARITY_MIN = 30;

/**
 * Compute bookable slots for a service over a date range.
 *
 * Slots are "rolling" start times, not fixed back-to-back blocks: within each day's rule window, a
 * candidate start is offered every `granularityMin` minutes (default DEFAULT_SLOT_GRANULARITY_MIN),
 * for as long as [start, start + serviceDuration) fits before the window closes with `serviceBuffer`
 * minutes still free after it (so the operator always has buffer/cleanup time before close-of-day,
 * same as she would between two back-to-back appointments), and the candidate doesn't overlap any
 * blocked_slot or existing confirmed appointment (extended by serviceBuffer — see below).
 *
 * @param {Array<{weekday:number, start_time:string, end_time:string}>} rules - recurring weekly hours (local wall-clock)
 * @param {Array<{start_at:string|Date, end_at:string|Date}>} blocks - one-off blocked ranges (absolute instants)
 * @param {Array<{start_at:string|Date, end_at:string|Date}>} existingAppointments - confirmed appointments (any service);
 *   each is treated as busy for [start_at, end_at + serviceBuffer) — see report/comment below for why serviceBuffer
 *   (the *requested* service's buffer) is what extends every existing appointment's busy window, not each
 *   appointment's own original service's buffer: the plan describes availability as "existing appointments
 *   (+ that service's buffer_min)" where "that service" reads as the service being queried for, and Diaka is a
 *   single operator so any prior appointment needs the same runway before the *next* (queried) service can start.
 * @param {number} serviceDuration - minutes, length of the slot being requested
 * @param {number} serviceBuffer - minutes, buffer required after any busy period before this service can start
 * @param {{from:string, to:string}} dateRange - inclusive 'YYYY-MM-DD' local calendar dates
 * @param {string} timezone - IANA zone name, e.g. 'America/New_York'
 * @param {number} [granularityMin] - minutes between rolling candidate start times; defaults to
 *   DEFAULT_SLOT_GRANULARITY_MIN. Configurable per-call (e.g. for tests, or a future per-service override)
 *   rather than hardcoded in the loop below.
 * @returns {Array<{date:string, slots:Array<{start:string, end:string}>}>} one entry per date in range,
 *   `start`/`end` are ISO-8601 UTC instants
 */
function computeSlots(
  rules, blocks, existingAppointments, serviceDuration, serviceBuffer, dateRange, timezone,
  granularityMin = DEFAULT_SLOT_GRANULARITY_MIN
) {
  const rulesByWeekday = new Map();
  for (const r of rules) {
    if (!rulesByWeekday.has(r.weekday)) rulesByWeekday.set(r.weekday, []);
    rulesByWeekday.get(r.weekday).push(r);
  }

  // Busy windows: blocked_slots as-is, existing appointments extended by the requested service's buffer.
  const busy = [
    ...blocks.map((b) => ({ start: toMillis(b.start_at), end: toMillis(b.end_at) })),
    ...existingAppointments.map((a) => ({
      start: toMillis(a.start_at),
      end: toMillis(a.end_at) + serviceBuffer * 60000,
    })),
  ];

  const durationMs = serviceDuration * 60000;
  const bufferMs = serviceBuffer * 60000;
  const granularityMs = granularityMin * 60000;
  const results = [];

  for (const { y, m, d } of eachDate(dateRange.from, dateRange.to)) {
    const dateStr = formatYmd(y, m, d);
    const weekday = weekdayOf(y, m, d);
    const dayRules = rulesByWeekday.get(weekday) || [];
    const slots = [];

    for (const rule of dayRules) {
      const start = parseTimeOfDay(rule.start_time);
      const end = parseTimeOfDay(rule.end_time);
      const dayStart = zonedWallTimeToUtc(y, m, d, start.hh, start.mm, timezone).getTime();
      const dayEnd = zonedWallTimeToUtc(y, m, d, end.hh, end.mm, timezone).getTime();

      // Rolling start times: a candidate every `granularityMs`, as long as the service itself PLUS
      // its post-service buffer still fits before the window closes (not just the service alone) —
      // the same runway that's required between two back-to-back appointments is required before close.
      for (
        let slotStart = dayStart;
        slotStart + durationMs + bufferMs <= dayEnd;
        slotStart += granularityMs
      ) {
        const slotEnd = slotStart + durationMs;
        const blocked = busy.some((b) => overlaps(slotStart, slotEnd, b.start, b.end));
        if (!blocked) {
          slots.push({ start: new Date(slotStart).toISOString(), end: new Date(slotEnd).toISOString() });
        }
      }
    }

    results.push({ date: dateStr, slots });
  }

  return results;
}

// The 'YYYY-MM-DD' calendar date a given instant falls on, as read on a clock in `timeZone`.
// Used by /api/book.js to bucket a requested UTC start time into "which local day's rules apply".
function localDateStringInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = {
  computeSlots, zonedWallTimeToUtc, weekdayOf, localDateStringInZone, DEFAULT_SLOT_GRANULARITY_MIN,
};
