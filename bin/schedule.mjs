// Routine schedules: parsing, matching and the next or last time one comes due, in this Mac's local time.
//
// A schedule is written as one of:
//   weekdays HH:MM            Monday to Friday at that time
//   daily HH:MM               every day
//   hourly [:MM]              every hour at that minute (default :00)
//   weekly <day> HH:MM        once a week, e.g. "weekly fri 16:00"
//   cron <m> <h> <dom> <mon> <dow>   a raw 5-field cron line (also accepted without the word "cron")
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

// Any way of writing a schedule → { spec, cron, label }: spec is the normalized text the store keeps, label is for
// people ("Weekdays at 09:00").
export function parseSchedule(raw) {
  const text = `${raw ?? ''}`.trim().replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  let m;
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
    return { spec: `cron ${cron.text}`, cron, label: `Cron ${cron.text}` };
  }
  const line = text;
  if (line.split(' ').length === 5 && /^[\d*a-z]/i.test(line) && !/^(weekdays|daily|hourly|weekly)\b/.test(lower)) {
    const cron = parseCron(line);
    return { spec: `cron ${cron.text}`, cron, label: `Cron ${cron.text}` };
  }
  bad(`"${text}" isn't a schedule. Use "weekdays 09:00", "daily 09:00", "hourly :15", "weekly fri 16:00" or a cron line like "cron 0 9 * * 1-5".`);
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
  const d = new Date(date);
  return dayMatches(cron, d) && cron.hour.has(d.getHours()) && cron.minute.has(d.getMinutes());
}

const MAX_DAYS = 366 * 5;
const sorted = (set, desc) => [...set].sort((a, b) => (desc ? b - a : a - b));

// The latest time the schedule comes due at or before `at`, and after `after` (both Dates or ms), or null. Times are
// whole local minutes; a time that doesn't exist on a clock-change day is skipped.
export function lastDue(cron, at, after = -Infinity) {
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

// The first time the schedule comes due strictly after `after`, or null.
export function nextDue(cron, after) {
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
