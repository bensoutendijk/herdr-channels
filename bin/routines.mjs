// Routines: prompts a channel's chat gets on a schedule. This is the part of them that touches no file, no process
// and no clock of its own: what a routine is, how one is added, changed and removed on a channel object, which runs
// a tick claims, the message a run types into the chat, and the words the command and the chat prompt use.
//
// The channels command here and the hub channels command elsewhere both run this same file, so a routine behaves
// and reads the same on either. A backend keeps its own storage (it calls these inside its store's lock), its own
// timer and its own way of getting a run into the chat. Copies of this file elsewhere are verbatim (with a version
// and sha256 note), so change it here, release, and copy the released file back. It needs only ./schedule.mjs,
// which goes beside it.
//
// Words name three things a backend passes in: `who` (who sets routines up: "the user"), `where` (whose clock and
// timer they run on: "this Mac") and `cli` (the command a chat or person types: "channels").
//
// A channel object here is { name, routines: [...], queue: [...] }. A queue entry is a run waiting for the chat, as
// data: { id (runId), routine (its id), name, kind: 'scheduled' | 'manual', scheduled_for, prompt and label (as they
// were when it was queued), by, first, prev, queued_at, text }. Its message is made when it is typed in (renderRun),
// so it says how late it really is; `text` is the message as it read when queued, for a listener from before that
// (and older entries have only `text`).
//
// The channel's `runs` is the run ledger: one record per run, oldest first, kept after the run is over and after its
// routine is deleted (the newest RUN_DEFAULTS.keep of each routine). A run is { id (runId), routine, name, trigger:
// { kind: 'scheduled' | 'manual', label, by }, due_at, queued_at, delivered_at, ended_at, late_min, state, note, error,
// tasks: [{ session_id, job, name }], grace_min, deadline, reported_late, waiting, reason, catchup_min }. Its state:
// - queued: waiting for the chat (its queue entry); undelivered once it has waited its grace time (error says why).
// - delivered: typed into the chat, which reports how it went (reportRun): ok or failed, with a one-line note.
// - unreported: the chat said nothing by its deadline (sweepRuns), and no task started for it says how it went.
// - missed: it came due while the timer couldn't run it, outside the catch-up window. cancelled: dropped or deleted.
// A routine's health (routineStatus with the runs) comes from these; `r.last` is still written for older readers.
import { randomUUID } from 'node:crypto';
import { defaultCatchup, due, MANUAL_LABEL, nextDue, parseSchedule, ScheduleError, scheduleWarnings, shortWhen, timeZone } from './schedule.mjs';

// What this file refuses (a bad name, schedule or prompt, a routine that isn't there): the message says why, for the
// person or chat that asked. A backend shows it the way it shows its own usage errors.
export class RoutineError extends Error {}
const fail = (msg) => { throw new RoutineError(msg); };

export const ROUTINE_DEFAULTS = { catchupMin: 60 };

// The run ledger's settings: how long a delivered run may go without a report (grace_min, a routine's own when set;
// 0 means it is done once delivered), how many bad runs in a row make a routine failing (fail_after), how many runs of
// each routine are kept, how long a run waits on tasks started for it, the gap between ticks that means the machine
// slept, and how long after a due time with no run a routine is overdue.
export const RUN_DEFAULTS = { graceMin: 30, failAfter: 2, keep: 30, taskCapMs: 12 * 3_600_000, sleepGapMs: 5 * 60_000, overdueMs: 3 * 60_000 };
const OPEN = new Set(['queued', 'delivered']);
const BAD = new Set(['failed', 'unreported', 'undelivered', 'missed']);

// What a slot that comes due does while a run of the same routine still waits for the chat: it is skipped, so a busy
// chat never finds a pile of the same prompt. A constant for now, not a setting of each routine.
export const OVERLAP = 'skip';
export const SKIP_WHY = 'already waiting for the chat';

const NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const oneLine = (s) => `${s ?? ''}`.replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const hm = (ms) => { const d = new Date(ms); return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`; };
const iso = (ms) => new Date(ms).toISOString();
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A moment with its day spelled out, so nobody has to work out which day "09:00" was: "Monday, Nov 23, 09:00", or
// "Mon Nov 23, 09:00" short. By hand: some runtimes ignore toLocaleString's options.
export const dayTime = (ms, { short = false } = {}) => {
  const d = new Date(ms);
  const day = WEEKDAYS[d.getDay()];
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${short ? day.slice(0, 3) : `${day},`} ${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${hm(ms)}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// A length of time in a few words: "14 min", "2 h 5 min", "3 days".
const span = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return plural(Math.floor(m / 1440), 'day');
};
// A catch-up window in words: "catch-up 1 hour", "catch-up 15 min", "no catch-up".
const catchupWords = (min) => (!min ? 'no catch-up' : min % 1440 === 0 ? `catch-up ${plural(min / 1440, 'day')}` : min % 60 === 0 ? `catch-up ${plural(min / 60, 'hour')}` : `catch-up ${min} min`);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// A day in a few words: the time today, the weekday this week, else the date ("Nov 3").
const dayWords = (ms, now) => {
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return hm(ms);
  return Math.abs(now - ms) < 6 * 86_400_000 ? DAYS[d.getDay()] : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

export function routineName(raw) {
  const name = `${raw ?? ''}`.trim().toLowerCase();
  if (!NAME.test(name)) fail(`A routine name is lowercase letters, digits, "-" and "_", up to 80, e.g. morning-plan (got "${raw ?? ''}").`);
  return name;
}

export function schedule(raw) {
  try { return parseSchedule(raw); } catch (err) { if (err instanceof ScheduleError) fail(err.message); throw err; }
}

// A catch-up window: minutes, or 15m, 2h, 1d; 0, "off" and "none" mean never run late.
export function catchupMinutes(raw) {
  const t = `${raw ?? ''}`.trim().toLowerCase();
  if (t === 'off' || t === 'none' || t === 'no') return 0;
  const m = /^(\d+)\s*(m|min|mins|minutes?|h|hours?|d|days?)?$/.exec(t);
  if (!m) fail(`A catch-up window is minutes, or a length like 15m, 2h or 1d (got "${raw}").`);
  const n = Number(m[1]) * (m[2]?.startsWith('h') ? 60 : m[2]?.startsWith('d') ? 1440 : 1);
  if (n > 7 * 1440) fail('A catch-up window is at most 7 days.');
  return n;
}

// A grace time (--grace): how long a delivered run may go without a report. Minutes, or 15m, 2h; 0 means don't wait.
export function graceMinutes(raw) {
  const t = `${raw ?? ''}`.trim().toLowerCase();
  if (t === 'off' || t === 'none' || t === 'no') return 0;
  const m = /^(\d+)\s*(m|min|mins|minutes?|h|hours?)?$/.exec(t);
  if (!m) fail(`A grace time is minutes, or a length like 15m or 2h; 0 means don't wait for a report (got "${raw}").`);
  const n = Number(m[1]) * (m[2]?.startsWith('h') ? 60 : 1);
  if (n > 720) fail('A grace time is at most 12 hours.');
  return n;
}

// --fail-after: how many bad runs in a row (failed, unreported, undelivered, missed) make a routine failing.
export function failAfter(raw) {
  const n = Number(`${raw ?? ''}`.trim());
  if (!Number.isInteger(n) || n < 1 || n > 20) fail(`--fail-after is how many bad runs in a row make a routine failing, 1 to 20 (got "${raw ?? ''}").`);
  return n;
}

// A note on switching a routine off (--note): why, in one line.
export const pauseNote = (raw) => { const n = cut(oneLine(raw), 200); return n || null; };

// Who asked for a run or a switch (`--by`): dialog, chat or cli for a run; you or chat for on/off. Any short word.
export function byName(raw) {
  const by = `${raw ?? ''}`.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,23}$/.test(by)) fail(`--by is who asked, one short word: dialog, chat, cli or you (got "${raw ?? ''}").`);
  return by;
}

export function routineOf(c, name) {
  const r = c.routines.find((x) => x.name === name);
  if (!r) fail(`#${c.name} has no routine "${name}". Its routines: ${c.routines.map((x) => x.name).join(', ') || 'none yet'}.`);
  return r;
}

// A routine as list --json shows it: what's stored, its schedule in words, its next run and its status (routineStatus,
// in words that name `where`). `runs`: its channel's run ledger, which its status and health come from (a backend
// that keeps none leaves it out, and the status reads `last`).
export function showRoutine(r, now = Date.now(), { where = 'this Mac', runs = null } = {}) {
  let label = r.schedule;
  let next = null;
  let error = null;
  try {
    const s = parseSchedule(r.schedule);
    label = s.label;
    if (r.enabled) next = nextDue(s.cron, now);
  } catch (err) { error = err.message; }
  return {
    id: r.id, name: r.name, prompt: r.prompt, schedule: r.schedule, label, catchup_min: r.catchup_min, enabled: Boolean(r.enabled),
    created_at: r.created_at, next_at: next ? iso(next) : null, last: r.last ?? null, skipped: r.skipped ?? null, paused: r.paused ?? null, error,
    grace_min: r.grace_min ?? RUN_DEFAULTS.graceMin, fail_after: r.fail_after ?? RUN_DEFAULTS.failAfter,
    status: routineStatus(r, now, { where, runs }),
  };
}

const needPrompt = (prompt) => { if (!`${prompt ?? ''}`.trim()) fail('A routine needs a prompt: what the chat is asked when it runs.'); };

// Adds a routine to channel c. Answers it as showRoutine does. Without a catch-up window it gets its schedule's default (defaultCatchup).
export function addRoutine(c, { name, prompt, spec, catchupMin, graceMin = null, failAfter: fa = null, enabled = true, now = Date.now() }) {
  needPrompt(prompt);
  const s = schedule(spec);
  catchupMin ??= defaultCatchup(s);
  if (c.routines.some((x) => x.name === name)) fail(`#${c.name} already has a routine "${name}".`);
  const at = iso(now);
  const r = { id: `rt_${randomUUID().replace(/-/g, '').slice(0, 10)}`, name, prompt: `${prompt}`.trim(), schedule: s.spec, catchup_min: catchupMin, enabled, created_at: at, since: at, done: null, last: null };
  if (graceMin != null) r.grace_min = graceMin;
  if (fa != null) r.fail_after = fa;
  c.routines.push(r);
  return showRoutine(r, now);
}

// Checks a change before the store is opened, so a bad schedule or an empty prompt fails without a write. Answers the
// change with its schedule normalized.
export function checkChange(change) {
  const out = { ...change };
  if (out.schedule != null) out.schedule = schedule(out.schedule).spec;
  if (out.prompt != null) needPrompt(out.prompt);
  return out;
}

// What a queue entry is: older entries carry no kind, and only a run-now's text says "run now".
export const entryKind = (e) => e.kind ?? (/^\[routine [^\]]*, run now\]/.test(e.text ?? '') ? 'manual' : 'scheduled');

// Changes routine `name` of channel c: { rename, schedule, prompt, catchupMin, graceMin, failAfter, enabled, by, note },
// all at once. Switching it off records who did it, when and why (`paused`: { by, at, note }); switching it on clears
// that. A note on a routine that is off already replaces its note. A new schedule,
// or switching it on, starts it afresh: times before now don't count as missed. Switching it off drops its scheduled
// runs still waiting for the chat (a run now stays: the user asked for it). Answers { routine (as showRoutine
// does), dropped (how many runs it dropped) }.
export function editRoutine(c, name, change, now = Date.now()) {
  const ch = checkChange(change);
  const r = routineOf(c, name);
  if (ch.note != null && (ch.enabled ?? r.enabled)) fail(`A note goes with switching a routine off: ${r.name} stays on, so there's nothing to note.`);
  if (ch.rename != null && ch.rename !== r.name) {
    if (c.routines.some((x) => x.name === ch.rename)) fail(`#${c.name} already has a routine "${ch.rename}".`);
    r.name = ch.rename;
    // Its runs carry its name, so a run reads right after a rename (and after a delete, with the last name it had).
    for (const run of c.runs ?? []) if (run.routine === r.id) run.name = r.name;
  }
  const at = iso(now);
  if (ch.schedule != null && ch.schedule !== r.schedule) { r.schedule = ch.schedule; r.since = at; }
  if (ch.prompt != null) r.prompt = `${ch.prompt}`.trim();
  if (ch.catchupMin != null) r.catchup_min = ch.catchupMin;
  if (ch.graceMin != null) r.grace_min = ch.graceMin;
  if (ch.failAfter != null) r.fail_after = ch.failAfter;
  if (ch.enabled != null && ch.enabled !== r.enabled) {
    r.enabled = ch.enabled;
    if (r.enabled) { r.since = at; r.paused = null; } else r.paused = { by: ch.by ?? null, at, ...(ch.note ? { note: ch.note } : {}) };
  } else if (ch.note != null && !r.enabled) r.paused = { ...(r.paused ?? { by: ch.by ?? null, at }), note: ch.note };
  let dropped = 0;
  if (ch.enabled === false) {
    const gone = c.queue.filter((e) => e.routine === r.id && entryKind(e) !== 'manual');
    dropped = gone.length;
    c.queue = c.queue.filter((e) => !gone.includes(e));
    if (r.last?.message && gone.some((e) => e.id === r.last.message)) Object.assign(r.last, { status: 'dropped', dropped_at: at });
    for (const e of gone) endRun(c, e.id, 'cancelled', now, { error: 'dropped when the routine was switched off' });
  }
  return { routine: showRoutine(r, now), dropped };
}

// Removes routine `name` from channel c, with any of its runs still waiting for the chat. Answers the routine.
// Its runs stay in the ledger (shown as deleted); the ones still waiting are cancelled.
export function removeRoutine(c, name, now = Date.now()) {
  const r = routineOf(c, name);
  c.routines = c.routines.filter((x) => x !== r);
  c.queue = c.queue.filter((x) => x.routine !== r.id);
  for (const run of c.runs ?? []) if (run.routine === r.id && run.state === 'queued') endRun(c, run.id, 'cancelled', now, { error: 'the routine was deleted' });
  return r;
}

export const fenceRoutine = (text) => `${text}`.trim().replace(/<(\/?)routine-prompt/gi, '<$1routine_prompt');

// What a run asks of the chat beyond the routine's own prompt: one plain line with the outcome first (a quiet run
// stops there), the prompt's own limits on day and time checked against the real day and time, which it states, and
// a question only when the chat can't go on without one. A run now is someone asking for it at that moment, often to
// try it out, so the prompt's limits don't hold it back.
export function replyContract({ now = Date.now(), manual = false, who = 'the user', where = 'this Mac' } = {}) {
  return [
    `For you (it is ${dayTime(now)} on ${where}'s clock):`,
    `- Do what the prompt asks, as if ${who} had asked it here.`,
    `- Open your reply with one plain line that says the outcome. When there is nothing that needs ${who}, that line is the whole reply.`,
    manual
      ? `- ${who} asked for this run now, so do it even if the prompt limits when it applies (only on weekdays, not after 18:00).`
      : `- If the prompt limits when it applies (only on weekdays, not after 18:00, not on holidays), check that against the day and time above. When this run falls outside it, say so in that one line and stop.`,
    `- Don't ask ${who} anything unless you can't go on without an answer: ${who} may not be at the screen. If you must, ask once, at the end.`,
  ].join('\n');
}

// A run's id: its routine and the slot it is for ("rt_…@2026-11-23T08:00:00.000Z"), or when a run now was asked for
// ("rt_…@manual-…"). The same slot always gets the same id, so a run is queued once however often it is claimed.
export const runId = (r, { slot = null, now = Date.now() } = {}) => `${r.id}@${slot != null ? iso(slot) : `manual-${iso(now)}`}`;

// Who asked for a run now, as the run's message says it.
const askedBy = (by, who, channel) => ({
  dialog: `${who} asked, in the Routines dialog, for this routine of #${channel} to run now.`,
  chat: `This chat asked for this routine of #${channel} to run now.`,
  cli: `${who} asked, from the command line, for this routine of #${channel} to run now.`,
}[by] ?? `${who} asked for this routine of #${channel} to run now.`);

// The message a routine types into the chat. The header is "[routine <name> · <trigger> · run <id>]": the trigger is
// "scheduled 09:00" (with ", running 10:40" when it runs late) or "run now".
export function routineText({ channel, routine, slot = null, now = Date.now(), manual = false, label = null, id = null, by = null, first = false, prev = null, queuedAt = null, report = false, who = 'the user', where = 'this Mac', cli = 'channels' }) {
  if (label == null) { try { label = parseSchedule(routine.schedule).label; } catch { label = routine.schedule; } }
  const late = !manual && slot != null && now - slot > 2 * 60_000;
  const trigger = manual ? 'run now' : `scheduled ${shortWhen(slot, now)}${late ? `, running ${hm(now)}` : ''}`;
  const lines = [
    `[routine ${routine.name} · ${trigger}${id ? ` · run ${id}` : ''}] #${channel}`,
    manual
      ? `From the channels timer on ${where}: ${askedBy(by, who, channel)}`
      : `From the channels timer on ${where}, not typed by ${who} just now: a routine ${who} set up for #${channel} came due (${label}).`,
  ];
  // Late because the timer didn't run then, or because the chat couldn't take it when it was queued on time.
  const timerLate = queuedAt == null || queuedAt - slot > 2 * 60_000;
  if (late) lines.push(`It is late: it was due at ${shortWhen(slot, now)} and runs at ${hm(now)}, because ${timerLate ? `the timer on ${where} couldn't run it then (asleep or off)` : 'the chat couldn\'t take it until now'}.`);
  if (first) lines.push('This is its first run.');
  else if (prev?.status === 'missed' && prev.due_at) lines.push(`Its previous run was missed: it was due ${shortWhen(Date.parse(prev.due_at), now)}${prev.reason ? `, while ${where} was ${prev.reason}` : ''}.`);
  lines.push('', `The routine's prompt, as ${who} wrote it:`, '<routine-prompt>', fenceRoutine(routine.prompt), '</routine-prompt>', '',
    replyContract({ now, manual, who, where }));
  if (report && id) lines.push(reportLine({ channel, id, cli }));
  return lines.join('\n');
}

// The run's last line: how the chat reports back (reportRun), and how a task it starts is tied to the run.
export const reportLine = ({ channel, id, cli = 'channels' }) => `- When you've finished (or started the tasks that will do it), report how it went: \`${cli} routine report ${channel} ${id} ok --note "<one line>"\` (or \`failed --note "<why>"\`). Pass \`--run ${id}\` to \`${cli} start\` for any task you start for it.`;

// A queue entry's message, made when it is typed in (now): late, first and who asked as they stand then. An entry
// from before entries were data has only its text.
export function renderRun(e, { channel, now = Date.now(), who, where, cli } = {}) {
  if (e.prompt == null) return e.text;
  const slot = e.scheduled_for ? Date.parse(e.scheduled_for) : null;
  return routineText({ channel, routine: { name: e.name, prompt: e.prompt }, slot, now, manual: entryKind(e) === 'manual', label: e.label, id: e.id, by: e.by, first: e.first, prev: e.prev, queuedAt: e.queued_at ? Date.parse(e.queued_at) : null, report: e.report === true, who, where, cli });
}

// Records a run of routine r in channel c: queued for the chat, or missed (`missed`: { reason: 'asleep'|'off' }, why
// the timer didn't run it). A run whose id (runId) is queued already is left as it is. Answers the queue entry.
export function queueRun(c, r, { kind, slot = null, now, status = 'queued', by = null, label = null, missed = null, channel = c.name, who, where, cli }) {
  const id = runId(r, { slot, now });
  if (status === 'queued') {
    const there = c.queue.find((e) => e.id === id);
    if (there) return there;
  }
  recordRun(c, r, { id, kind, slot, now, state: status, by, label, missed, where });
  const prev = r.last ? { status: r.last.status, due_at: r.last.due_at ?? null, reason: r.last.reason ?? null } : null;
  let entry = null;
  if (status === 'queued') {
    entry = { id, routine: r.id, name: r.name, kind, scheduled_for: slot != null ? iso(slot) : null, prompt: r.prompt, label, by, first: !r.last, prev: prev?.status === 'missed' ? prev : null, queued_at: iso(now), report: graceOf(r) > 0 };
    entry.text = renderRun(entry, { channel, now, who, where, cli });
    c.queue.push(entry);
  }
  r.last = {
    id, kind, status, due_at: slot != null ? iso(slot) : null, at: iso(now), late_min: slot != null ? Math.max(0, Math.round((now - slot) / 60_000)) : 0, message: entry ? id : null,
    ...(by ? { by } : {}), ...(status === 'missed' ? { reason: missed?.reason ?? null, catchup_min: r.catchup_min } : {}),
  };
  return entry;
}

// "Run now" on routine `name` of channel c: queued for the chat at once. The schedule doesn't move. `by`: who asked.
export function runNow(c, name, { now = Date.now(), by = null, who, where, cli } = {}) {
  const r = routineOf(c, name);
  return queueRun(c, r, { kind: 'manual', now, by, who, where, cli });
}

// Why queue entry `id` of channel c can't reach the chat yet, on its routine's last run: `waiting` = { why, since }.
// since stays from the first reason given. Answers whether anything changed.
export function markWaiting(c, id, why, now = Date.now()) {
  const text = cut(oneLine(why), 200);
  if (!text) return false;
  let changed = false;
  const run = runOf(c, id);
  if (run && (run.state === 'queued' || run.state === 'undelivered') && run.waiting?.why !== text) {
    run.waiting = { why: text, since: run.waiting?.since ?? iso(now) };
    changed = true;
  }
  const e = c.queue.find((x) => x.id === id);
  const r = c.routines.find((x) => x.id === e?.routine);
  const l = r?.last;
  if (!l || l.message !== id || l.status !== 'queued' || l.waiting?.why === text) return changed;
  l.waiting = { why: text, since: l.waiting?.since ?? iso(now) };
  return true;
}

// Takes queue entry `id` of channel c off the queue once the chat has it, and says so on its routine's last run.
// Answers the entry, or null when it was already gone.
export function markDelivered(c, id, now = Date.now()) {
  const e = c.queue.find((x) => x.id === id);
  c.queue = c.queue.filter((x) => x.id !== id);
  const r = c.routines.find((x) => x.id === e?.routine);
  if (r?.last && r.last.message === id) { Object.assign(r.last, { status: 'delivered', delivered_at: iso(now) }); delete r.last.waiting; }
  const run = runOf(c, id);
  if (run && (run.state === 'queued' || run.state === 'undelivered')) {
    delete run.waiting;
    Object.assign(run, { delivered_at: iso(now), error: null });
    // A run whose message asked for no report (no grace time, or queued before runs were reported) is done now.
    if (!run.grace_min || e?.report === false) Object.assign(run, { state: 'ok', ended_at: iso(now), deadline: null });
    else Object.assign(run, { state: 'delivered', deadline: iso(now + run.grace_min * 60_000) });
  }
  return e ?? null;
}

// ---------- the run ledger ----------

const graceOf = (r) => r.grace_min ?? RUN_DEFAULTS.graceMin;
export const runOf = (c, id) => (c.runs ?? []).find((x) => x.id === id) ?? null;

// A run's record in channel c's ledger, made when it is queued or found missed (queueRun). A run already there is
// left as it is. Older runs of the routine beyond RUN_DEFAULTS.keep go.
function recordRun(c, r, { id, kind, slot = null, now, state = 'queued', by = null, label = null, missed = null, where = 'this Mac' }) {
  c.runs ??= [];
  const there = runOf(c, id);
  if (there) return there;
  if (label == null && kind !== 'manual') { try { label = parseSchedule(r.schedule).label; } catch { label = r.schedule; } }
  const grace = graceOf(r);
  const run = {
    id, routine: r.id, name: r.name, trigger: { kind, label: kind === 'manual' ? 'run now' : label, by: by ?? null },
    due_at: slot != null ? iso(slot) : null, queued_at: state === 'queued' ? iso(now) : null, delivered_at: null, ended_at: state === 'queued' ? null : iso(now),
    late_min: slot != null ? Math.max(0, Math.round((now - slot) / 60_000)) : 0, state, note: null, error: null, tasks: [], grace_min: grace,
    // A queued run that hasn't reached the chat in its grace time (30 min when it has none) is undelivered.
    deadline: state === 'queued' ? iso(now + (grace || RUN_DEFAULTS.graceMin) * 60_000) : null, reported_late: false,
    ...(state === 'missed' ? { reason: missed?.reason ?? null, catchup_min: r.catchup_min, error: `${missed?.reason ? `${where} was ${missed.reason} at the time` : `the timer on ${where} didn't run at the time`} (${catchupWords(r.catchup_min)})` } : {}),
  };
  c.runs.push(run);
  trimRuns(c);
  return run;
}

// Keeps the newest `keep` runs of each routine (deleted ones too), and every run still open.
export function trimRuns(c, keep = RUN_DEFAULTS.keep) {
  const seen = new Map();
  const out = [];
  for (let i = (c.runs ?? []).length - 1; i >= 0; i--) {
    const run = c.runs[i];
    const n = (seen.get(run.routine) ?? 0) + 1;
    seen.set(run.routine, n);
    if (n <= keep || OPEN.has(run.state)) out.push(run);
  }
  c.runs = out.reverse();
}

function endRun(c, id, state, now, { note = null, error = null } = {}) {
  const run = runOf(c, id);
  if (!run) return null;
  Object.assign(run, { state, ended_at: iso(now), deadline: null, ...(note != null ? { note } : {}), ...(error != null ? { error } : {}) });
  return run;
}

// The runs a report or a task can still be tied to, in words for an error: "rt_…@… (morning-plan, delivered)".
const openList = (c) => (c.runs ?? []).filter((x) => OPEN.has(x.state) || x.state === 'unreported' || x.state === 'undelivered')
  .map((x) => `${x.id} (${x.name}, ${x.state})`).join(', ') || 'none';

// The chat's report on run `id` of channel c: outcome 'ok' or 'failed', with a one-line note. A run that went
// unreported (or undelivered) takes a late report; one already reported, missed or cancelled refuses it. Answers the run.
export function reportRun(c, id, outcome, { note = null, now = Date.now() } = {}) {
  if (outcome !== 'ok' && outcome !== 'failed') fail(`A report is ok or failed (got "${outcome ?? ''}").`);
  const run = runOf(c, id);
  if (!run) fail(`#${c.name} has no run ${id}. Its runs waiting for a report: ${openList(c)}.`);
  if (run.state === 'ok' || run.state === 'failed') fail(`Run ${id} of ${run.name} was already reported ${run.state}${run.note ? ` ("${run.note}")` : ''}: a run is reported once.`);
  if (run.state === 'missed' || run.state === 'cancelled') fail(`Run ${id} of ${run.name} never reached the chat (${run.state}${run.error ? `: ${run.error}` : ''}), so there is nothing to report.`);
  const late = run.state === 'unreported' || run.state === 'undelivered';
  run.delivered_at ??= iso(now);
  delete run.waiting;
  endRun(c, id, outcome, now, { note: note == null ? null : cut(oneLine(note), 500) || null });
  run.error = null;
  run.reported_late = late;
  return run;
}

// Checks that run `id` of channel c can still take a task (before the task starts): it is queued or delivered.
export function openRun(c, id) {
  const run = runOf(c, id);
  if (!run) fail(`#${c.name} has no run ${id}. Its open runs: ${openList(c)}.`);
  if (!OPEN.has(run.state)) fail(`Run ${id} of ${run.name} is over (${run.state}): a task can be tied only to a run that is queued or delivered.`);
  return run;
}

// Ties a task ({ session_id, job, name }) to run `id` of channel c: the run lists it, and when the chat doesn't report,
// its outcome comes from its tasks (sweepRuns).
export function linkTask(c, id, task) {
  const run = openRun(c, id);
  const key = task.session_id ?? task.job;
  if (!run.tasks.some((t) => (t.session_id ?? t.job) === key)) run.tasks.push({ session_id: task.session_id ?? null, job: task.job ?? null, name: task.name ?? '' });
  return run;
}

// What every tick does after claimDue, in the store's lock: runs past their deadline end. A queued run turns
// undelivered (with why it waits); a delivered one takes its tasks' outcome when they are all over, waits while one
// still runs (up to RUN_DEFAULTS.taskCapMs), else turns unreported. A queued run whose entry left the queue without a
// delivery being recorded here was typed in by a chat's listener from before runs were reported: it is ok.
// `tasks`: a Map from a linked task's session_id (or job) to 'running' | 'ok' | 'failed' (a backend reads its
// harnesses for the tasks tasksToCheck names). `gapMs`: the time since the last tick; over RUN_DEFAULTS.sleepGapMs
// the machine slept, and every open deadline moves on by it. Answers what changed: [{ channel, routine, id, state, why }].
export function sweepRuns(store, now = Date.now(), { tasks = new Map(), gapMs = 0 } = {}) {
  const out = [];
  for (const c of store.channels) {
    if (c.archived_at) continue;
    for (const run of c.runs ?? []) {
      if (!OPEN.has(run.state)) continue;
      if (gapMs > RUN_DEFAULTS.sleepGapMs && run.deadline) run.deadline = iso(Date.parse(run.deadline) + gapMs);
      const ended = (state, why) => { endRun(c, run.id, state, now, why); out.push({ channel: c.name, routine: run.name, id: run.id, state, why: run.error ?? run.note ?? null }); };
      if (run.state === 'queued') {
        if (!c.queue.some((e) => e.id === run.id)) {
          if (!c.routines.some((r) => r.id === run.routine)) { ended('cancelled', { error: 'the routine was deleted' }); continue; }
          run.delivered_at ??= iso(now);
          ended('ok', {});
          continue;
        }
        if (run.deadline && now > Date.parse(run.deadline)) ended('undelivered', { error: run.waiting?.why ? `it couldn't reach the chat: ${run.waiting.why}` : 'it didn\'t reach the chat in time' });
        continue;
      }
      if (!run.deadline || now <= Date.parse(run.deadline)) continue;
      const states = run.tasks.map((t) => tasks.get(t.session_id ?? t.job) ?? null);
      if (states.length && states.every((x) => x === 'ok' || x === 'failed')) {
        const failed = states.includes('failed');
        ended(failed ? 'failed' : 'ok', { note: cut(`Tasks: ${run.tasks.map((t, i) => `${t.name || t.session_id}${states[i] === 'failed' ? ' (failed)' : ''}`).join(', ')}`, 500), ...(failed ? { error: 'a task started for it failed' } : {}) });
        continue;
      }
      if (states.length && now - Date.parse(run.delivered_at ?? run.queued_at) < RUN_DEFAULTS.taskCapMs) continue;
      ended('unreported', { error: states.length ? `its tasks were still running after ${span(RUN_DEFAULTS.taskCapMs)}, and the chat didn't report` : `the chat didn't report back within ${span(run.grace_min * 60_000)}` });
    }
  }
  return out;
}

// The tasks whose outcome a sweep needs: those of delivered runs past their deadline. [{ channel, task }].
export function tasksToCheck(store, now = Date.now()) {
  const out = [];
  for (const c of store.channels) {
    if (c.archived_at) continue;
    for (const run of c.runs ?? []) if (run.state === 'delivered' && run.deadline && now > Date.parse(run.deadline)) for (const t of run.tasks) out.push({ channel: c.name, task: t });
  }
  return out;
}

// The tick log's line for one of sweepRuns' answers.
export const sweepLine = (x) => `run ${x.id} of #${x.channel} ${x.routine} ${x.state}${x.why ? `: ${x.why}` : ''}`;

// A run as `routine runs --json` shows it: the record, how long it took (minutes, from delivery; null while open or
// when it never ran), and whether its routine is gone.
export function showRun(c, run) {
  const from = Date.parse(run.delivered_at ?? '');
  const to = Date.parse(run.ended_at ?? '');
  const took = Number.isFinite(from) && Number.isFinite(to) && (run.state === 'ok' || run.state === 'failed') ? Math.max(0, Math.round((to - from) / 60_000)) : null;
  return { ...run, duration_min: took, deleted: !c.routines.some((r) => r.id === run.routine) };
}

// Channel c's runs, newest first: all, or routine `name`'s (a deleted routine's too, by the name its runs kept).
export function listRuns(c, name = null, { limit = 20 } = {}) {
  const r = name ? c.routines.find((x) => x.name === name) : null;
  if (name && !r && !(c.runs ?? []).some((x) => x.name === name)) fail(`#${c.name} has no routine "${name}", and no runs of one. Its routines: ${c.routines.map((x) => x.name).join(', ') || 'none yet'}.`);
  const mine = (c.runs ?? []).filter((x) => !name || (r ? x.routine === r.id : x.name === name));
  return mine.slice(-limit).reverse().map((x) => showRun(c, x));
}

const STATE_WORDS = { queued: 'waiting', delivered: 'running', ok: 'ok', failed: 'failed', unreported: 'no report', undelivered: 'undelivered', missed: 'missed', cancelled: 'cancelled' };
export const runStateWords = (state) => STATE_WORDS[state] ?? state;

// `routine runs` in words: one line a run, "Mon 09:00  ok  2 min  morning-plan: Nothing needs you".
export function runsText(runs, { now = Date.now(), name = null } = {}) {
  if (!runs.length) return name ? `${name} hasn't run yet.` : 'No routine has run yet.';
  return runs.map((x) => {
    const at = x.due_at ?? x.queued_at ?? x.ended_at;
    const when = at ? shortWhen(Date.parse(at), now) : '-';
    const late = x.late_min > 2 && x.state !== 'missed' ? ` (${x.late_min} min late)` : '';
    const manual = x.trigger?.kind === 'manual' ? ' (run now)' : '';
    const took = x.duration_min != null ? `  ${span(x.duration_min * 60_000)}` : '';
    const what = x.note ?? x.error ?? (x.state === 'delivered' ? 'waiting for the chat\'s report' : x.state === 'queued' ? (x.waiting?.why ?? 'waiting for the chat') : '');
    const tasks = x.tasks?.length ? `  [tasks: ${x.tasks.map((t) => t.name || t.session_id).join(', ')}]` : '';
    return `${when}${late}${manual}  ${runStateWords(x.state)}${took}  ${x.name}${x.deleted ? ' (deleted)' : ''}${x.reported_late ? ' (reported late)' : ''}${what ? `: ${what}` : ''}${tasks}`;
  }).join('\n');
}

// A routine's state, in one model for the command, the dialog and the sidebar: { state, words, at }. state is off,
// broken (its schedule doesn't read), never (no run yet), waiting (a run waits for the chat), missed (the last slot
// passed while the timer couldn't run it), late (the last run reached the chat more than 2 minutes after it was due)
// or ok. words say it for a person ("Waiting 14 min: a draft is typed in the chat's prompt"); at is when it began.
//
// With the channel's run ledger (`runs`), it is the routine's health too. Before everything but off and broken:
// failing (its newest fail_after finished runs all went badly: failed, unreported, undelivered or missed; with streak
// and failing_since) and overdue (a due time passed over 3 minutes ago with no run: the timer didn't run it). Then
// waiting (a run waits for the chat), running (the chat has a run and hasn't reported yet), and the newest finished
// run: ok, late, failed, unreported, undelivered or missed.
export function routineStatus(r, now = Date.now(), { where = 'this Mac', runs = null } = {}) {
  let s;
  try { s = parseSchedule(r.schedule); } catch (err) { return { state: 'broken', words: `Can't run: ${err.message}`, at: null }; }
  if (!r.enabled) {
    const p = r.paused;
    const by = !p?.by ? '' : p.by === 'you' ? ' · switched off by you' : p.by === 'chat' ? ' · switched off by the chat' : p.by === 'cli' ? ' · switched off from the command line' : ` · switched off by ${p.by}`;
    const note = p?.note ? ` · "${p.note}"` : '';
    return { state: 'off', words: `${p?.at ? `Off since ${dayWords(Date.parse(p.at), now)}${by}` : 'Off'}${note}`, at: p?.at ?? null };
  }
  const mine = Array.isArray(runs) ? runs.filter((x) => x.routine === r.id) : [];
  if (mine.length) return healthOf(r, s, mine, now, where);
  if (Array.isArray(runs) && !r.last) { const o = overdue(r, s, now); if (o) return o; }
  return lastStatus(r, now, where);
}

// A routine on a schedule whose due time passed over RUN_DEFAULTS.overdueMs ago, unclaimed: the timer didn't run.
// A scheduled run recorded for that time (its due_at) counts as the timer having run it.
function overdue(r, s, now, mine = []) {
  if (!s.cron) return null;
  const ran = mine.map((x) => Date.parse(x.due_at ?? '') || 0);
  const from = Math.max(Date.parse(r.since ?? r.created_at ?? '') || 0, Date.parse(r.done ?? '') || 0, ...ran);
  if (!from) return null;
  const n = nextDue(s.cron, from);
  if (n == null || now - n <= RUN_DEFAULTS.overdueMs) return null;
  return { state: 'overdue', words: `Overdue: due ${shortWhen(n, now)}, and the timer hasn't run it`, at: iso(n) };
}

const runAt = (x) => Date.parse(x.due_at ?? x.queued_at ?? x.ended_at);

function healthOf(r, s, mine, now, where) {
  const finished = mine.filter((x) => !OPEN.has(x.state) && x.state !== 'cancelled').reverse();
  const fa = r.fail_after ?? RUN_DEFAULTS.failAfter;
  let streak = 0;
  while (streak < finished.length && BAD.has(finished[streak].state)) streak++;
  const open = [...mine].reverse().find((x) => OPEN.has(x.state));
  const skip = r.skipped;
  const skipped = skip?.due_at && skip.at && open?.queued_at && skip.at > open.queued_at ? ` · skipped ${skip.count > 1 ? `${skip.count}, last ` : ''}${shortWhen(Date.parse(skip.due_at), now)}` : '';
  if (streak >= fa && streak > 0) {
    const first = finished[streak - 1];
    const since = iso(runAt(first));
    const why = finished[0].note ?? finished[0].error;
    const doing = open ? ` · ${open.state === 'queued' ? 'a run waits for the chat' : 'a run is going'}` : '';
    return { state: 'failing', words: `Failing · ${streak} in a row since ${shortWhen(Date.parse(since), now)}${why ? `: ${why}` : ''}${doing}`, at: since, streak, failing_since: since };
  }
  const late = overdue(r, s, now, mine);
  if (late && !open) return late;
  if (open?.state === 'queued') {
    const since = Date.parse(open.queued_at);
    const why = open.waiting?.why;
    const fresh = now - since < 60_000;
    const words = why ? `Waiting${fresh ? '' : ` ${span(now - since)}`}: ${why}` : fresh ? 'Queued for the chat…' : `Waiting ${span(now - since)} for the chat`;
    return { state: 'waiting', words: `${words}${open.trigger?.kind === 'manual' ? ' · run now' : ''}${skipped}`, at: open.queued_at };
  }
  if (open) {
    const tasks = open.tasks.length ? ` · ${plural(open.tasks.length, 'task')}` : '';
    return { state: 'running', words: `Running since ${shortWhen(Date.parse(open.delivered_at), now)}${tasks}${open.trigger?.kind === 'manual' ? ' · run now' : ''}${skipped}`, at: open.delivered_at };
  }
  const x = finished[0] ?? [...mine].reverse()[0];
  const manual = x.trigger?.kind === 'manual';
  const when = shortWhen(runAt(x), now);
  const took = x.delivered_at && x.ended_at ? ` · ${span(Date.parse(x.ended_at) - Date.parse(x.delivered_at))}` : '';
  const said = x.note ? `: ${x.note}` : '';
  if (x.state === 'missed') return { state: 'missed', words: `Skipped ${when}${x.reason ? `: ${where} was ${x.reason} until ${hm(Date.parse(x.ended_at))}` : ''} (${catchupWords(x.catchup_min ?? r.catchup_min)})`, at: x.due_at };
  if (x.state === 'cancelled') return { state: 'ok', words: `${manual ? 'Run now' : 'Due'} ${when} · dropped when switched off`, at: x.ended_at };
  if (x.state === 'failed') return { state: 'failed', words: `Failed ${when}${took}${said || (x.error ? `: ${x.error}` : '')}`, at: x.ended_at };
  if (x.state === 'unreported') return { state: 'unreported', words: `No report ${when}: ${x.error ?? 'the chat didn\'t say how it went'}`, at: x.ended_at };
  if (x.state === 'undelivered') return { state: 'undelivered', words: `Didn't reach the chat ${when}${x.error ? `: ${x.error.replace(/^it /, '')}` : ''}`, at: x.ended_at };
  const lateMs = !manual && x.due_at && x.delivered_at ? Date.parse(x.delivered_at) - Date.parse(x.due_at) : 0;
  if (lateMs > 2 * 60_000) return { state: 'late', words: `Done ${when}, ${span(lateMs)} late${took}${said}`, at: x.ended_at };
  return { state: 'ok', words: `Done ${when}${took}${manual ? ' · run now' : ''}${said}`, at: x.ended_at };
}

// The status from the routine's `last` alone: a backend that keeps no ledger, or a routine with no run in it yet.
function lastStatus(r, now, where) {
  const l = r.last;
  const s = r.skipped;
  // Slots skipped while this run waited: only a skip after it was recorded (a run now has no due time).
  const skipped = s?.due_at && s.at && (!l?.at || s.at > l.at) ? ` · skipped ${s.count > 1 ? `${s.count}, last ` : ''}${shortWhen(Date.parse(s.due_at), now)}` : '';
  if (!l) return { state: 'never', words: 'Never run', at: null };
  const manual = l.kind === 'manual';
  if (l.status === 'queued') {
    const since = Date.parse(l.at);
    const why = l.waiting?.why ?? (typeof l.waiting === 'string' ? l.waiting : null);
    const fresh = now - since < 60_000;
    const words = why ? `Waiting${fresh ? '' : ` ${span(now - since)}`}: ${why}` : fresh ? 'Queued for the chat…' : `Waiting ${span(now - since)} for the chat`;
    return { state: 'waiting', words: `${words}${manual ? ' · run now' : ''}${skipped}`, at: l.at };
  }
  if (l.status === 'missed') {
    const due = shortWhen(Date.parse(l.due_at), now);
    const why = l.reason ? `: ${where} was ${l.reason} until ${hm(Date.parse(l.at))}` : '';
    return { state: 'missed', words: `Skipped ${due}${why} (${catchupWords(l.catchup_min ?? r.catchup_min)})`, at: l.due_at };
  }
  if (l.status === 'dropped') return { state: 'ok', words: `${manual ? 'Run now' : 'Due'} ${shortWhen(Date.parse(l.due_at ?? l.at), now)} · dropped when switched off`, at: l.dropped_at ?? l.at };
  const got = Date.parse(l.delivered_at ?? l.at);
  const late = !manual && l.due_at ? got - Date.parse(l.due_at) : 0;
  if (late > 2 * 60_000) return { state: 'late', words: `Delivered ${shortWhen(got, now)} · due ${shortWhen(Date.parse(l.due_at), now)}, ${span(late)} late${skipped}`, at: iso(got) };
  return { state: 'ok', words: `Delivered ${shortWhen(got, now)}${manual ? ' · run now' : ''}${skipped}`, at: iso(got) };
}

// The timer's heartbeat, which a backend writes after each tick (tick.json): when it ran, on what version, and what it
// did. list --json shows `timer: timerStatus(heartbeat)`; a heartbeat older than TIMER_STALE_MS means the timer stopped.
export const TIMER_STALE_MS = 5 * 60_000;
export const heartbeat = ({ now = Date.now(), version = null, claimed = 0, sent = 0, errors = 0 } = {}) => ({ at: iso(now), version, claimed, sent, errors });
export const timerStatus = (beat, now = Date.now()) => ({ last_tick_at: beat?.at ?? null, stale: beat?.at ? now - Date.parse(beat.at) > TIMER_STALE_MS : null });

// One look at every routine of a store ({ channels: [...] }), inside the store's lock so two ticks can't both claim a
// run: each slot that came due is claimed (the routine's `done`) before anything is sent, then queued for the chat
// (fire), recorded as missed (outside the catch-up window), or skipped because a run of it still waits for the chat.
// Answers what it did: [{ channel, routine, action: 'fire'|'missed'|'skip', due_at, late_min }]. bootedAt (when the
// machine last started) tells a missed slot's reason: it was off then, or else asleep.
export function claimDue(store, now = Date.now(), { who, where, bootedAt = null } = {}) {
  const out = [];
  for (const c of store.channels) {
    if (c.archived_at) continue;
    for (const r of c.routines) {
      if (!r.enabled) continue;
      let s;
      try { s = parseSchedule(r.schedule); } catch { continue; }
      const d = due({ cron: s.cron, since: r.since, done: r.done, catchupMin: r.catchup_min, now });
      if (!d) continue;
      r.done = iso(d.slot);
      let action = d.action;
      if (action === 'fire' && c.queue.some((e) => e.routine === r.id)) {
        action = OVERLAP;
        r.skipped = { due_at: r.done, at: iso(now), why: SKIP_WHY, count: (r.skipped?.count ?? 0) + 1 };
      } else if (action === 'fire') {
        queueRun(c, r, { kind: 'scheduled', slot: d.slot, now, label: s.label, who, where });
        r.skipped = null;
      } else queueRun(c, r, { kind: 'scheduled', slot: d.slot, now, status: 'missed', missed: { reason: bootedAt != null && bootedAt > d.slot ? 'off' : 'asleep' }, where });
      out.push({ channel: c.name, routine: r.name, action, due_at: r.done, late_min: Math.round(d.late_ms / 60_000) });
    }
  }
  return out;
}

// The tick log's line for one of claimDue's answers.
export const claimLine = (x) => `${x.action === 'fire' ? 'fired' : x.action === 'skip' ? 'skipped' : 'missed'} #${x.channel} ${x.routine} due ${x.due_at}${x.late_min > 2 ? ` (${x.late_min} min late)` : ''}${x.action === 'skip' ? `: ${SKIP_WHY}` : ''}`;

// For the Routines dialog: a schedule in words and its next runs ({ spec, label, next }), or what is wrong ({ error }).
// Also: manual (no time: next is empty), catchup_min (the window a new routine on it gets), tz (the zone of the clock
// it keeps) and warnings (a time it uses that doesn't exist on a clock-change night, in words).
export function preview(raw, now = Date.now()) {
  try {
    const s = parseSchedule(raw);
    const next = [];
    for (let t = now, i = 0; i < 3; i++) { t = nextDue(s.cron, t); if (t == null) break; next.push(iso(t)); }
    return { spec: s.spec, label: s.label, next, manual: Boolean(s.manual), catchup_min: defaultCatchup(s), tz: timeZone(), warnings: scheduleWarnings(s.cron, now) };
  } catch (err) {
    if (!(err instanceof ScheduleError)) throw err;
    return { error: err.message };
  }
}

export const previewText = (p, now = Date.now()) => p.error ?? (p.manual ? `${p.label}.` : `${p.label}. Next: ${p.next.map((x) => shortWhen(Date.parse(x), now)).join(', ')}`);

// A routine in one line: "morning-plan: Weekdays at 09:00, next Mon 09:00, catch-up 60 min."
export const said = (r) => `${r.name}: ${r.enabled ? r.label : `off (${r.label})`}${r.next_at ? `, next ${shortWhen(Date.parse(r.next_at))}` : ''}, catch-up ${r.catchup_min} min.`;

// A length of minutes in words: "45 min", "2 hours", "1 day".
const lengthText = (min) => {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return min >= 1440 && min % 1440 === 0 ? unit(min / 1440, 'day') : min >= 60 && min % 60 === 0 ? unit(min / 60, 'hour') : `${min} min`;
};

// A routine's next `n` runs from `now` (ms), none when it is off, manual or its schedule doesn't parse.
function nextRuns(r, n, now) {
  if (!r.enabled) return [];
  let cron;
  try { cron = parseSchedule(r.schedule).cron; } catch { return []; }
  const out = [];
  for (let t = now; cron && out.length < n;) { t = nextDue(cron, t); if (t == null) break; out.push(t); }
  return out;
}

// The block add, edit, on and off print, which the chat passes on as it is: what the routine is, when it runs in
// words, whether it is on, its next two runs, its catch-up window, the first line of its prompt and where to change
// it. A dry run heads it "Would set up:" and saves nothing.
export function routineBlock({ channel, routine: r, head, dropped = 0, now = Date.now(), where = 'this Mac', cli = 'channels' }) {
  const manual = r.label === MANUAL_LABEL || r.schedule === 'manual';
  const next = nextRuns(r, 2, now);
  const first = `${r.prompt ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [
    ['Routine', `${r.name} in #${channel}`],
    ['When', manual ? `${r.label} (no schedule)` : `${r.label}, ${where}'s time`],
    ['Status', r.enabled ? 'on' : manual ? 'off' : 'off: it won\'t run on its schedule until it is switched on'],
  ];
  if (manual) rows.push(['Runs', `only when run: Run now in Routines, or ${cli} routine run ${channel} ${r.name}`]);
  if (!manual && r.enabled) rows.push(['Next runs', next.length ? next.map((t) => dayTime(t, { short: true })).join(' and ') : 'none coming']);
  if (!manual) rows.push(['Catch-up', r.catchup_min ? `runs up to ${lengthText(r.catchup_min)} late if ${where} was asleep or off at the time` : `none: a run ${where} misses is skipped`]);
  rows.push(['Prompt', `${JSON.stringify(cut(first[0] ?? '', 90))}${first.length > 1 ? ` (+${first.length - 1} more line${first.length > 2 ? 's' : ''})` : ''}`]);
  if (dropped) rows.push(['Dropped', `${dropped} run${dropped === 1 ? '' : 's'} that ${dropped === 1 ? 'was' : 'were'} waiting for the chat`]);
  rows.push(['To change', `ask in #${channel}'s chat, or open Routines in #${channel}'s menu (${cli} routine edit ${channel} ${r.name} …)`]);
  return [head, ...rows.map(([k, v]) => `  ${`${k}:`.padEnd(11)}${v}`)].join('\n');
}

// What the command prints after a routine command: { verb: 'add'|'edit'|'on'|'off'|'rm'|'run', channel, routine
// (showRoutine's, or the name for rm), dropped, run (for run: { address, started }), dry (a --dry-run of add or edit:
// nothing was saved) }, in the words of `where` and `cli`.
export function confirmation({ verb, channel, routine, dropped = 0, run = null, dry = false, now = Date.now(), where = 'this Mac', cli = 'channels' }) {
  const block = (head) => routineBlock({ channel, routine, head, dropped, now, where, cli });
  if (dry && ['add', 'edit', 'on', 'off'].includes(verb)) return `${block('Would set up:')}\n(A dry run: nothing is saved. Run the same command without --dry-run to ${verb === 'add' ? 'set it up' : 'make the change'}.)`;
  if (verb === 'add') return block(`Added a routine to #${channel}:`);
  if (verb === 'edit') return block(`Changed #${channel}'s routine ${routine.name}:`);
  if (verb === 'on' || verb === 'off') return block(`Switched #${channel}'s routine ${routine.name} ${verb}:`);
  if (verb === 'rm') return `Removed #${channel}'s routine ${routine?.name ?? routine}.`;
  if (verb === 'run') return `Queued #${channel}'s routine ${routine?.name ?? routine} for its chat${run?.started ? `, which was started in the background (terminal ${run.address})` : run?.address ? ` (terminal ${run.address})` : ''}.`;
  return '';
}

// The routine commands' usage, for `cli` on `where`'s clock.
export const routineUsage = ({ cli = 'channels', where = 'this Mac' } = {}) => [
  `${cli} routine list [<channel>] [--json]`,
  `${cli} routine add <channel> <name> --schedule <schedule> [--catchup <window>] [--grace <time>] [--fail-after <n>] [--off] [--dry-run] <prompt | ->`,
  `${cli} routine edit <channel> <name> [--schedule <schedule>] [--catchup <window>] [--grace <time>] [--fail-after <n>] [--prompt <text | ->] [--rename <new-name>] [--on | --off] [--note <why>] [--dry-run]`,
  `${cli} routine rm <channel> <name>`,
  `${cli} routine run|on|off <channel> <name> [--by <who>] [--note <why>]   (who asked: dialog, chat or cli for run; you or chat for on/off; --note with off)`,
  `${cli} routine runs <channel> [<name>] [--limit <n>] [--json]   past runs, newest first`,
  `${cli} routine report <channel> <run-id> ok|failed [--note <text | ->]   the chat's report on a run`,
  `${cli} routine preview <schedule> [--json]`,
  `Schedules (${where}'s local time): "weekdays 09:00", "daily 09:00", "hourly :15", "weekly fri 16:00", "cron <5 fields>", or "manual" (only when run).`,
  `--dry-run checks everything and prints what it would set up, headed "Would set up:", without saving.`,
  `A catch-up window (default by schedule: 15 minutes for several runs a day, 60 for daily, 4 hours for weekly): how late a run the timer on ${where} missed may still fire, e.g. 15m, 2h, 1d or 0.`,
  `A grace time (default ${RUN_DEFAULTS.graceMin} min): how long the chat has to report a run before it counts as unreported; 0 means a run is done once delivered. --fail-after (default ${RUN_DEFAULTS.failAfter}): how many bad runs in a row make a routine failing.`,
].join('\n');

// `routine list` in words: the channels of a list ({ channels: [{ name, routines (as showRoutine), queued }] }).
export function listText(out, { cli = 'channels' } = {}) {
  const lines = [];
  const on = out.channels.some((c) => c.routines.some((r) => r.enabled));
  if (on && out.timer?.stale) lines.push(`The timer hasn't run since ${dayTime(Date.parse(out.timer.last_tick_at), { short: true })}, so routines won't come due.${out.timer.hint ? ` Start it again: ${out.timer.hint}` : ''}`, '');
  for (const c of out.channels) {
    if (!c.routines.length) continue;
    lines.push(`#${c.name}${c.queued ? `  (${c.queued} waiting for the chat)` : ''}`);
    for (const r of c.routines) {
      lines.push(`  ${r.name}  ${r.enabled ? 'on ' : 'off'}  ${r.label}  catch-up ${r.catchup_min} min  next ${r.next_at ? shortWhen(Date.parse(r.next_at)) : '-'}  ${r.status?.words ?? ''}`);
      lines.push(`    ${JSON.stringify(cut(oneLine(r.prompt), 100))}`);
    }
  }
  if (!lines.length) lines.push(`No routines yet. Add one with: ${cli} routine add <channel> <name> --schedule "weekdays 09:00" <prompt>`);
  return lines.join('\n');
}

const fallback = (n) => (n === 2 ? 'two' : `${n}`);

// The chat prompt's paragraph on routines, for channel `name`: what a run looks like and how to answer it, how to set
// one up (rounding a request no schedule fits, a one-off, proposing with --dry-run, passing on the confirmation),
// and how to answer "why didn't it run?" from routine list --json.
export function promptText({ name, who = 'the user', where = 'this Mac', cli = 'channels' }) {
  return [
    `Routines: prompts this chat gets on a schedule, set up by ${who}. When one comes due, a message opening with "[routine <name> · scheduled <time> · run <id>]" arrives here on its own, from the channels timer on ${where}, with the prompt between <routine-prompt> markers; it says "running <time>" too when it runs late because the timer couldn't run it on time. Do what its prompt asks, and answer the way its "For you" lines say: one plain line with the outcome first (a run with nothing for ${who} stops there), the prompt's own limits on day and time checked against the day and time the message gives, and a question only when you can't go on without one.`,
    `When ${who} asks for something recurring ("every weekday at 9, ask me for my plan"), set it up:`,
    `- \`${cli} routine add ${name} <name> --schedule "<schedule>" [--catchup <window>] -\`, with the prompt on stdin. <name> is short, lowercase, with dashes (morning-plan). Schedules are in ${where}'s local time: "weekdays 09:00", "daily 18:30", "hourly :15", "weekly fri 16:00", a cron line "cron 0 9 * * 1-5", or "manual" for one ${who} only runs by hand. The catch-up window (default 15 minutes for several runs a day, 1 hour for daily, 4 hours for weekly; 15m, 2h, 1d, 0) is how late a run the timer missed (${where} asleep or off) may still happen. Write the prompt as ${who} would ask it of you at that time, standing on its own.`,
    `- A request no schedule fits ("every 90 minutes", "the first Monday of the month", "every other Friday", "around lunch"): pick the nearest schedule that does, and say what you chose and why. Limits a schedule can't hold ("only the first Monday", "skip holidays") go in the prompt, which the run checks against the date. In a cron line with both a day of the month and a weekday, a day matching either one runs.`,
    `- Something once ("remind me at 3 tomorrow"): a routine on a cron line for that date and time ("cron 0 15 24 11 *"), with --catchup 1d so it still runs if ${where} was asleep, and a prompt that ends: "Then remove this routine: ${cli} routine rm ${name} <name>". It removes itself when it runs.`,
    `- add and edit take --dry-run: every check runs and the confirmation prints headed "Would set up:", with nothing saved. When you rounded a schedule, made a one-off or aren't sure what ${who} meant, propose it that way and set it up once ${who} agrees.`,
    `- add, edit, on and off print a short confirmation block (the routine, when in words, on or off, the next two runs, the catch-up, the prompt's first line, where to change it). Pass it on to ${who} as it is, in a code block, not retold.`,
    `- \`${cli} routine list ${name}\` shows them with their next and last runs; \`${cli} routine edit ${name} <name> [--schedule ...] [--catchup ...] [--prompt -] [--on|--off]\`, \`${cli} routine on|off|rm ${name} <name>\` change them and \`${cli} routine run ${name} <name> --by chat\` runs one now (\`routine off … --by chat --note "<why>"\` when you switch one off, with why when ${who} said, "on holiday until Dec 2"). A run that comes due while the last one still waits for this chat is skipped, not stacked. Change routines only when ${who} asks.`,
    `When ${who} asks why a routine didn't run (or ran late, or twice), read \`${cli} routine list ${name} --json\` rather than guess, and answer in plain words with the days and times. Each routine has: enabled (false: switched off, so nothing runs on schedule); next_at (its next run; null when off or manual); error (its schedule no longer reads); last, its most recent run, with due_at, at, late_min, kind (scheduled or manual, a run now) and status: queued (waiting to be typed into this chat, which was busy or not running), delivered (typed into this chat at delivered_at), missed (it came due while ${where} was asleep or off and the timer got to it after the catch-up window, catchup_min, had passed, so it didn't run), dropped (it was waiting when the routine was switched off); and skipped (a later time came due while a run still waited for this chat, so it was skipped, count times, the last at skipped.due_at). Each routine's status ({ state, words }) says all that in one line, the same words the Routines dialog shows: start from it. last.waiting.why says why a queued run hasn't reached this chat yet; a missed last run has reason (asleep or off); paused says who switched a routine off and when; last.id is the run id its message's header showed. The channel's queued counts runs still waiting. A new schedule or switching on starts afresh: times before that are neither run nor missed.`,
    `Reporting a run: a routine's message ends with how to report it. When you've done what it asks (or started the tasks that will do it), run \`${cli} routine report ${name} <run id> ok --note "<one line>"\`, or \`failed --note "<why>"\` when you couldn't do it. Pass \`--run <run id>\` to \`${cli} start\` for any task you start for a run: when you don't report, the run takes its outcome from those tasks. A run with no report after its grace time counts as unreported, and ${fallback(RUN_DEFAULTS.failAfter)} bad runs in a row make a routine failing. When ${who} asks how a routine has been doing (or why it didn't run on a day), read \`${cli} routine runs ${name} [<routine>] --json\`: each run's state (ok, failed, unreported, undelivered, missed, cancelled, or queued and delivered while open), due_at, delivered_at, ended_at, duration_min, note, error and tasks. Each routine's status there has state failing (with streak and failing_since), overdue (the timer didn't run it), running, waiting or the last run's state.`,
  ].join('\n');
}
