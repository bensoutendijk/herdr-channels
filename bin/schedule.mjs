// Routine schedules: parsing, matching and the next or last time one comes due, in this Mac's local time.
//
// A schedule is written as one of:
//   weekdays HH:MM            Monday to Friday at that time
//   daily HH:MM               every day
//   hourly [:MM]              every hour at that minute (default :00)
//   weekly <day> HH:MM        once a week, e.g. "weekly fri 16:00"
//   cron <m> <h> <dom> <mon> <dow>   a raw 5-field cron line (also accepted without the word "cron")
//   manual                    no time at all: it runs only when someone runs it (cron is null, nothing comes due)
// Times take "9", "9:30", "09:30", "9am", "9:30pm". Every form becomes a cron line; the normalized text is what
// the store keeps. Cron follows the usual rules: lists, ranges, steps, month and day names, 0 and 7 are Sunday,
// and when both day-of-month and day-of-week are restricted a day matching either one counts.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FIELDS = [
  { key: 'minute', lo: 0, hi: 59 },
  { key: 'hour', lo: 0, hi: 23 },
  { key: 'day', lo: 1, hi: 31 },
  { key: 'month', lo: 1, hi: 12, names: MONTHS, base: 1 },
  { key: 'weekday', lo: 0, hi: 7, names: DAYS, base: 0 },
];

export class ScheduleError extends Error {}
const bad = (msg) => { throw new ScheduleError(msg); };
const pad = (n) => `${n}`.padStart(2, '0');

// "9", "9:30", "09:30", "9am", "12:15pm" → { h, m }.
export function parseTime(raw) {
  const t = `${raw ?? ''}`.trim().toLowerCase().replace(/^at\s+/, '');
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) bad(`"${raw}" isn't a time: use HH:MM, like 09:00 or 16:30.`);
  let h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) bad(`"${raw}" isn't a time: with am or pm the hour is 1 to 12.`);
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59) bad(`"${raw}" isn't a time of day.`);
  return { h, m: min };
}

function dayIndex(raw) {
  const d = `${raw ?? ''}`.trim().toLowerCase();
  const i = DAYS.findIndex((x) => d === x || (d.length >= 3 && DAY_NAMES[DAYS.indexOf(x)].toLowerCase().startsWith(d)));
  if (i === -1) bad(`"${raw}" isn't a day: use mon, tue, wed, thu, fri, sat or sun.`);
  return i;
}

function parseField(text, f) {
  const out = new Set();
  const name = (s) => {
    if (/^\d+$/.test(s)) return Number(s);
    const i = f.names ? f.names.indexOf(s.toLowerCase()) : -1;
    return i === -1 ? NaN : i + f.base;
  };
  for (const part of text.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
    if (!m) return null;
    let lo = f.lo;
    let hi = f.key === 'weekday' ? 6 : f.hi;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-');
      lo = name(a);
      hi = b == null ? (m[2] ? (f.key === 'weekday' ? 6 : f.hi) : lo) : name(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < f.lo || hi > f.hi || lo > hi) return null;
    }
    const step = m[2] == null ? 1 : Number(m[2]);
    if (!(step >= 1)) return null;
    for (let v = lo; v <= hi; v += step) out.add(f.key === 'weekday' && v === 7 ? 0 : v);
  }
  return out;
}

// A 5-field cron line → { minute, hour, day, month, weekday } as Sets, plus whether day and weekday were "*".
export function parseCron(line) {
  const parts = `${line ?? ''}`.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) bad(`A cron line has 5 fields: minute hour day month weekday (got ${parts.length || 'none'}).`);
  const cron = {};
  FIELDS.forEach((f, i) => {
    const set = parseField(parts[i], f);
    if (!set || !set.size) {
      const range = f.key === 'weekday' ? 'sun–sat or 0–7' : f.key === 'month' ? 'jan–dec or 1–12' : `${f.lo}–${f.hi}`;
      bad(`${f.key[0].toUpperCase()}${f.key.slice(1)} "${parts[i]}" isn't a number, range, list or step in ${range}.`);
    }
    cron[f.key] = set;
  });
  cron.anyDay = parts[2] === '*';
  cron.anyWeekday = parts[4] === '*';
  cron.text = parts.join(' ');
  return cron;
}

const hhmm = (h, m) => `${pad(h)}:${pad(m)}`;
const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ascending = (set) => [...set].sort((a, b) => a - b);
const whole = (set, f) => set.size === (f.key === 'weekday' ? 7 : f.hi - f.lo + 1);
// A set that is every n-th value from the field's start ("*/n") → n; else 0.
function stepOf(set, f) {
  const hi = f.key === 'weekday' ? 6 : f.hi;
  const vals = ascending(set);
  if (vals.length < 2 || vals[0] !== f.lo) return 0;
  const n = vals[1] - vals[0];
  return vals.every((v, i) => v === f.lo + i * n) && vals[vals.length - 1] + n > hi ? n : 0;
}

// A parsed cron line in words for the common shapes ("Mon, Wed, Fri at 09:00", "Every 30 minutes",
// "The 1st of each month at 09:00"), or null when it has none and "Cron <line>" has to do.
export function describeCron(cron) {
  if (!cron) return null;
  const [fm, fh, , fmon] = FIELDS;
  const mins = ascending(cron.minute);
  const hours = ascending(cron.hour);
  // One date a year at one time, the way a one-off routine is written: "Nov 23 at 14:30, each year".
  if (cron.month.size === 1 && cron.day.size === 1 && cron.anyWeekday && mins.length === 1 && hours.length === 1) {
    const mo = MONTHS[[...cron.month][0] - 1];
    return `${mo[0].toUpperCase()}${mo.slice(1)} ${[...cron.day][0]} at ${hhmm(hours[0], mins[0])}, each year`;
  }
  if (!whole(cron.month, fmon)) return null;
  const anyTime = cron.anyDay && cron.anyWeekday;
  if (whole(cron.hour, fh)) {
    if (!anyTime) return null;
    if (whole(cron.minute, fm)) return 'Every minute';
    const n = stepOf(cron.minute, fm);
    if (n) return `Every ${n} minutes`;
    return mins.length === 1 ? `Every hour at :${pad(mins[0])}` : null;
  }
  const n = stepOf(cron.hour, fh);
  if (anyTime && n && mins.length === 1) return `Every ${n} hours at :${pad(mins[0])}`;
  // Fixed times of day: up to four of them.
  if (mins.length * hours.length > 4) return null;
  const times = andList(hours.flatMap((h) => mins.map((m) => hhmm(h, m))));
  if (anyTime) return `Every day at ${times}`;
  if (cron.anyDay) {
    const days = ascending(cron.weekday).join(',');
    if (days === '1,2,3,4,5') return `Weekdays at ${times}`;
    if (days === '0,6') return `Weekends at ${times}`;
    if (cron.weekday.size === 1) return `${DAY_NAMES[[...cron.weekday][0]]}s at ${times}`;
    return `${[1, 2, 3, 4, 5, 6, 0].filter((d) => cron.weekday.has(d)).map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')} at ${times}`;
  }
  if (cron.anyWeekday && cron.day.size <= 3) return `The ${andList(ascending(cron.day).map(ordinal))} of each month at ${times}`;
  return null;
}

// The zone this computer's clock keeps, like "Europe/Amsterdam" (null when the runtime can't say).
export function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

// The times the schedule would come due in the next `days` that don't exist here, because the clocks go forward that
// night: nextDue skips them, so those runs don't happen. → [{ day: 'YYYY-MM-DD', times: ['HH:MM', ...] }], one entry
// per such day, at most `max` days.
export function skippedTimes(cron, from = Date.now(), { days = 366, max = 2 } = {}) {
  const out = [];
  if (!cron) return out;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i <= days && out.length < max; i++, day.setDate(day.getDate() + 1)) {
    // Only a day shorter than 24 hours has a time missing.
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    if (next.getTime() - day.getTime() >= 86_400_000 || !dayMatches(cron, day)) continue;
    const times = [];
    for (const h of ascending(cron.hour)) {
      for (const m of ascending(cron.minute)) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (t.getHours() !== h || t.getMinutes() !== m) times.push(hhmm(h, m));
      }
    }
    if (times.length) out.push({ day: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`, times });
  }
  return out;
}

// The first of skippedTimes as a sentence, for the Routines dialog (an empty list when there is none). Only for a
// schedule with a few fixed times a day: one that runs every hour or more often just has a run fewer that night.
export function scheduleWarnings(cron, from = Date.now()) {
  if (!cron || cron.hour.size * cron.minute.size > 4) return [];
  return skippedTimes(cron, from, { max: 1 }).map(({ day, times }) => {
    const [y, mo, d] = day.split('-').map(Number);
    const on = `${MONTHS[mo - 1][0].toUpperCase()}${MONTHS[mo - 1].slice(1)} ${d}, ${y}`;
    return times.length === 1
      ? `${times[0]} doesn't happen on ${on} (the clocks go forward), so that run is skipped.`
      : `The clocks go forward on ${on}, so the runs from ${times[0]} to ${times[times.length - 1]} are skipped.`;
  });
}

// The catch-up window a routine gets when none is given, in minutes: short for one that runs several times a day, so
// a late run can't land almost on the next one; an hour for a daily one; 4 hours for one a week or rarer.
export function defaultCatchup(schedule) {
  const cron = schedule?.cron;
  if (!cron) return 60;
  if (cron.hour.size > 1 || cron.minute.size > 1) return 15;
  const days = cron.anyDay ? (cron.anyWeekday ? 7 : cron.weekday.size) : cron.anyWeekday ? 1 : 7;
  return days <= 1 ? 240 : 60;
}

export const MANUAL_LABEL = 'Only when you run it';
const cronLabel = (cron) => describeCron(cron) ?? `Cron ${cron.text}`;

// Any way of writing a schedule → { spec, cron, label }: spec is the normalized text the store keeps, label is for
// people ("Weekdays at 09:00"). A manual schedule has cron null and manual true.
export function parseSchedule(raw) {
  const text = `${raw ?? ''}`.trim().replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  let m;
  if (lower === 'manual') return { spec: 'manual', cron: null, label: MANUAL_LABEL, manual: true };
  if ((m = /^(weekdays|daily|every day)(?: at)? (.+)$/.exec(lower))) {
    const { h, m: min } = parseTime(m[2]);
    const kind = m[1] === 'weekdays' ? 'weekdays' : 'daily';
    return { spec: `${kind} ${pad(h)}:${pad(min)}`, cron: parseCron(`${min} ${h} * * ${kind === 'weekdays' ? '1-5' : '*'}`), label: `${kind === 'weekdays' ? 'Weekdays' : 'Every day'} at ${pad(h)}:${pad(min)}` };
  }
  if ((m = /^(?:hourly|every hour)(?: at)?(?: :?(\d{1,2}))?$/.exec(lower))) {
    const min = m[1] == null ? 0 : Number(m[1]);
    if (min > 59) bad(`":${m[1]}" isn't a minute: use :00 to :59.`);
    return { spec: `hourly :${pad(min)}`, cron: parseCron(`${min} * * * *`), label: `Every hour at :${pad(min)}` };
  }
  if ((m = /^weekly(?: on)? ([a-z]+)(?: at)? (.+)$/.exec(lower))) {
    const d = dayIndex(m[1]);
    const { h, m: min } = parseTime(m[2]);
    return { spec: `weekly ${DAYS[d]} ${pad(h)}:${pad(min)}`, cron: parseCron(`${min} ${h} * * ${d}`), label: `${DAY_NAMES[d]}s at ${pad(h)}:${pad(min)}` };
  }
  if (lower === 'cron' || lower.startsWith('cron ')) {
    const cron = parseCron(text.slice(4));
    return { spec: `cron ${cron.text}`, cron, label: cronLabel(cron) };
  }
  const line = text;
  if (line.split(' ').length === 5 && /^[\d*a-z]/i.test(line) && !/^(weekdays|daily|hourly|weekly)\b/.test(lower)) {
    const cron = parseCron(line);
    return { spec: `cron ${cron.text}`, cron, label: cronLabel(cron) };
  }
  bad(`"${text}" isn't a schedule. Use "weekdays 09:00", "daily 09:00", "hourly :15", "weekly fri 16:00", a cron line like "cron 0 9 * * 1-5", or "manual".`);
}

function dayMatches(cron, d) {
  if (!cron.month.has(d.getMonth() + 1)) return false;
  const dom = cron.day.has(d.getDate());
  const dow = cron.weekday.has(d.getDay());
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return dow;
  if (cron.anyWeekday) return dom;
  return dom || dow;
}

export function matches(cron, date) {
  if (!cron) return false;
  const d = new Date(date);
  return dayMatches(cron, d) && cron.hour.has(d.getHours()) && cron.minute.has(d.getMinutes());
}

const MAX_DAYS = 366 * 5;
const sorted = (set, desc) => [...set].sort((a, b) => (desc ? b - a : a - b));

// The latest time the schedule comes due at or before `at`, and after `after` (both Dates or ms), or null. Times are
// whole local minutes; a time that doesn't exist on a clock-change day is skipped.
export function lastDue(cron, at, after = -Infinity) {
  if (!cron) return null;
  const end = Math.floor(new Date(at).getTime() / 60_000) * 60_000;
  const floor = Number.isFinite(Number(after)) ? Number(after) : after instanceof Date ? after.getTime() : -Infinity;
  const hours = sorted(cron.hour, true);
  const minutes = sorted(cron.minute, true);
  const day = new Date(end);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (day.getTime() + 86_400_000 * 1.1 <= floor) return null;
    if (dayMatches(cron, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          if (t.getHours() !== h || t.getMinutes() !== m) continue;
          const ms = t.getTime();
          if (ms > end) continue;
          return ms > floor ? ms : null;
        }
      }
    }
    day.setDate(day.getDate() - 1);
  }
  return null;
}

// The first time the schedule comes due strictly after `after`, or null (always, for a manual schedule).
export function nextDue(cron, after) {
  if (!cron) return null;
  const start = new Date(after).getTime();
  const hours = sorted(cron.hour, false);
  const minutes = sorted(cron.minute, false);
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (dayMatches(cron, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          if (t.getHours() !== h || t.getMinutes() !== m) continue;
          if (t.getTime() > start) return t.getTime();
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

// A run counts as on time when it fires within this long of its time: the timer ticks once a minute.
export const ON_TIME_MS = 2 * 60_000;

// What a routine should do at `now`: { slot, late_ms, action: 'fire' | 'missed' } or null. Only times after
// max(since, done) count: since is when the routine was made, switched on or rescheduled; done is the last time it
// handled. Of the times missed since then, only the latest is considered, so missed runs never stack: it fires when
// it is no later than the catch-up window (or the on-time margin), else it is recorded as missed.
export function due({ cron, since, done, catchupMin = 0, now }) {
  if (!cron) return null;
  const base = Math.max(since ? Date.parse(since) : -Infinity, done ? Date.parse(done) : -Infinity);
  const t = new Date(now).getTime();
  const slot = lastDue(cron, t, base);
  if (slot == null) return null;
  const late = t - slot;
  const window = Math.max(ON_TIME_MS, (Number(catchupMin) || 0) * 60_000);
  return { slot, late_ms: late, action: late <= window ? 'fire' : 'missed' };
}

// "09:00" for a time today, "Mon 09:00" within the week, else "Nov 3 09:00", relative to `now`.
export function shortWhen(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  const days = Math.abs(d.getTime() - n.getTime()) / 86_400_000;
  if (days < 6) return `${DAY_NAMES[d.getDay()].slice(0, 3)} ${hm}`;
  return `${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)} ${d.getDate()} ${hm}`;
}
