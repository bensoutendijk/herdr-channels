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
// A channel object here is { name, routines: [...], queue: [...] }. A queue entry is a run waiting for the chat:
// { id, routine (its id), name, kind: 'scheduled' | 'manual', text, queued_at }.
import { randomUUID } from 'node:crypto';
import { defaultCatchup, due, nextDue, parseSchedule, ScheduleError, scheduleWarnings, shortWhen, timeZone } from './schedule.mjs';

// What this file refuses (a bad name, schedule or prompt, a routine that isn't there): the message says why, for the
// person or chat that asked. A backend shows it the way it shows its own usage errors.
export class RoutineError extends Error {}
const fail = (msg) => { throw new RoutineError(msg); };

export const ROUTINE_DEFAULTS = { catchupMin: 60 };

// What a slot that comes due does while a run of the same routine still waits for the chat: it is skipped, so a busy
// chat never finds a pile of the same prompt. A constant for now, not a setting of each routine.
export const OVERLAP = 'skip';
export const SKIP_WHY = 'already waiting for the chat';

const NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const oneLine = (s) => `${s ?? ''}`.replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const hm = (ms) => { const d = new Date(ms); return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`; };
const iso = (ms) => new Date(ms).toISOString();

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

export function routineOf(c, name) {
  const r = c.routines.find((x) => x.name === name);
  if (!r) fail(`#${c.name} has no routine "${name}". Its routines: ${c.routines.map((x) => x.name).join(', ') || 'none yet'}.`);
  return r;
}

// A routine as list --json shows it: what's stored, its schedule in words and its next run.
export function showRoutine(r, now = Date.now()) {
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
    created_at: r.created_at, next_at: next ? iso(next) : null, last: r.last ?? null, skipped: r.skipped ?? null, error,
  };
}

const needPrompt = (prompt) => { if (!`${prompt ?? ''}`.trim()) fail('A routine needs a prompt: what the chat is asked when it runs.'); };

// Adds a routine to channel c. Answers it as showRoutine does. Without a catch-up window it gets its schedule's default (defaultCatchup).
export function addRoutine(c, { name, prompt, spec, catchupMin, enabled = true, now = Date.now() }) {
  needPrompt(prompt);
  const s = schedule(spec);
  catchupMin ??= defaultCatchup(s);
  if (c.routines.some((x) => x.name === name)) fail(`#${c.name} already has a routine "${name}".`);
  const at = iso(now);
  const r = { id: `rt_${randomUUID().replace(/-/g, '').slice(0, 10)}`, name, prompt: `${prompt}`.trim(), schedule: s.spec, catchup_min: catchupMin, enabled, created_at: at, since: at, done: null, last: null };
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

// Changes routine `name` of channel c: { rename, schedule, prompt, catchupMin, enabled }, all at once. A new schedule,
// or switching it on, starts it afresh: times before now don't count as missed. Switching it off drops its scheduled
// runs still waiting for the chat (a run now stays: the user asked for it). Answers { routine (as showRoutine
// does), dropped (how many runs it dropped) }.
export function editRoutine(c, name, change, now = Date.now()) {
  const ch = checkChange(change);
  const r = routineOf(c, name);
  if (ch.rename != null && ch.rename !== r.name) {
    if (c.routines.some((x) => x.name === ch.rename)) fail(`#${c.name} already has a routine "${ch.rename}".`);
    r.name = ch.rename;
  }
  const at = iso(now);
  if (ch.schedule != null && ch.schedule !== r.schedule) { r.schedule = ch.schedule; r.since = at; }
  if (ch.prompt != null) r.prompt = `${ch.prompt}`.trim();
  if (ch.catchupMin != null) r.catchup_min = ch.catchupMin;
  if (ch.enabled != null && ch.enabled !== r.enabled) { r.enabled = ch.enabled; if (r.enabled) r.since = at; }
  let dropped = 0;
  if (ch.enabled === false) {
    const gone = c.queue.filter((e) => e.routine === r.id && entryKind(e) !== 'manual');
    dropped = gone.length;
    c.queue = c.queue.filter((e) => !gone.includes(e));
    if (r.last?.message && gone.some((e) => e.id === r.last.message)) Object.assign(r.last, { status: 'dropped', dropped_at: at });
  }
  return { routine: showRoutine(r, now), dropped };
}

// Removes routine `name` from channel c, with any of its runs still waiting for the chat. Answers the routine.
export function removeRoutine(c, name) {
  const r = routineOf(c, name);
  c.routines = c.routines.filter((x) => x !== r);
  c.queue = c.queue.filter((x) => x.routine !== r.id);
  return r;
}

export const fenceRoutine = (text) => `${text}`.trim().replace(/<(\/?)routine-prompt/gi, '<$1routine_prompt');

// The message a routine types into the chat. The header says it is a routine, when it was due, and when it runs if
// that is late: "[routine morning-plan, scheduled 09:00, running 10:40]".
export function routineText({ channel, routine, slot = null, now = Date.now(), manual = false, label = null, who = 'the user', where = 'this Mac' }) {
  const late = !manual && slot != null && now - slot > 2 * 60_000;
  const head = manual ? `[routine ${routine.name}, run now]` : `[routine ${routine.name}, scheduled ${shortWhen(slot, now)}${late ? `, running ${hm(now)}` : ''}]`;
  const lines = [
    `${head} #${channel}`,
    manual
      ? `From the channels timer on ${where}: ${who} asked for this routine of #${channel} to run now.`
      : `From the channels timer on ${where}, not typed by ${who} just now: a routine ${who} set up for #${channel} came due (${label ?? routine.schedule}).`,
  ];
  if (late) lines.push(`It is late: it was due at ${shortWhen(slot, now)} and runs at ${hm(now)}, because the timer on ${where} couldn't run it then (asleep or off).`);
  lines.push('', `The routine's prompt, as ${who} wrote it:`, '<routine-prompt>', fenceRoutine(routine.prompt), '</routine-prompt>', '',
    `For you: do what the prompt asks, as if ${who} had asked it here. If you need ${who}, ask; ${who} may not be at the screen yet.`);
  return lines.join('\n');
}

// Records a run of routine r in channel c: queued for the chat (with its text), or missed. Answers the queue entry.
export function queueRun(c, r, { text, kind, slot = null, now, status = 'queued' }) {
  const id = randomUUID();
  const entry = status === 'queued' ? { id, routine: r.id, name: r.name, kind, text, queued_at: iso(now) } : null;
  if (entry) c.queue.push(entry);
  r.last = { kind, status, due_at: slot != null ? iso(slot) : null, at: iso(now), late_min: slot != null ? Math.max(0, Math.round((now - slot) / 60_000)) : 0, message: entry ? id : null };
  return entry;
}

// "Run now" on routine `name` of channel c: queued for the chat at once. The schedule doesn't move.
export function runNow(c, name, { now = Date.now(), who, where } = {}) {
  const r = routineOf(c, name);
  return queueRun(c, r, { text: routineText({ channel: c.name, routine: r, now, manual: true, who, where }), kind: 'manual', now });
}

// Takes queue entry `id` of channel c off the queue once the chat has it, and says so on its routine's last run.
// Answers the entry, or null when it was already gone.
export function markDelivered(c, id, now = Date.now()) {
  const e = c.queue.find((x) => x.id === id);
  c.queue = c.queue.filter((x) => x.id !== id);
  const r = c.routines.find((x) => x.id === e?.routine);
  if (r?.last && r.last.message === id) Object.assign(r.last, { status: 'delivered', delivered_at: iso(now) });
  return e ?? null;
}

// One look at every routine of a store ({ channels: [...] }), inside the store's lock so two ticks can't both claim a
// run: each slot that came due is claimed (the routine's `done`) before anything is sent, then queued for the chat
// (fire), recorded as missed (outside the catch-up window), or skipped because a run of it still waits for the chat.
// Answers what it did: [{ channel, routine, action: 'fire'|'missed'|'skip', due_at, late_min }].
export function claimDue(store, now = Date.now(), { who, where } = {}) {
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
        queueRun(c, r, { text: routineText({ channel: c.name, routine: r, slot: d.slot, now, label: s.label, who, where }), kind: 'scheduled', slot: d.slot, now });
        r.skipped = null;
      } else queueRun(c, r, { kind: 'scheduled', slot: d.slot, now, status: 'missed' });
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

// A routine in one line, as the command confirms a change: "morning-plan: Weekdays at 09:00, next Mon 09:00,
// catch-up 60 min."
export const said = (r) => `${r.name}: ${r.enabled ? r.label : `off (${r.label})`}${r.next_at ? `, next ${shortWhen(Date.parse(r.next_at))}` : ''}, catch-up ${r.catchup_min} min.`;
const droppedText = (n) => (n ? ` Dropped ${n} run${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} waiting for the chat.` : '');

// What the command prints after a routine command: { verb: 'add'|'edit'|'on'|'off'|'rm'|'run', channel, routine
// (showRoutine's, or the name for rm), dropped, run (for run: { address, started }) }.
export function confirmation({ verb, channel, routine, dropped = 0, run = null }) {
  if (verb === 'add') return `Added a routine to #${channel}: ${said(routine)}`;
  if (verb === 'edit') return `Changed #${channel}'s routine ${said(routine)}${droppedText(dropped)}`;
  if (verb === 'on' || verb === 'off') return `#${channel}'s routine ${said(routine)}${droppedText(dropped)}`;
  if (verb === 'rm') return `Removed #${channel}'s routine ${routine?.name ?? routine}.`;
  if (verb === 'run') return `Queued #${channel}'s routine ${routine?.name ?? routine} for its chat${run?.started ? `, which was started in the background (terminal ${run.address})` : run?.address ? ` (terminal ${run.address})` : ''}.`;
  return '';
}

// The routine commands' usage, for `cli` on `where`'s clock.
export const routineUsage = ({ cli = 'channels', where = 'this Mac' } = {}) => [
  `${cli} routine list [<channel>] [--json]`,
  `${cli} routine add <channel> <name> --schedule <schedule> [--catchup <window>] [--off] <prompt | ->`,
  `${cli} routine edit <channel> <name> [--schedule <schedule>] [--catchup <window>] [--prompt <text | ->] [--rename <new-name>] [--on | --off]`,
  `${cli} routine rm|run|on|off <channel> <name>`,
  `${cli} routine preview <schedule> [--json]`,
  `Schedules (${where}'s local time): "weekdays 09:00", "daily 09:00", "hourly :15", "weekly fri 16:00", "cron <5 fields>", or "manual" (only when run).`,
  `A catch-up window (default by schedule: 15 minutes for several runs a day, 60 for daily, 4 hours for weekly): how late a run the timer on ${where} missed may still fire, e.g. 15m, 2h, 1d or 0.`,
].join('\n');

// A routine's last run in words, for `routine list`.
function lastText(r) {
  const l = r.last;
  if (!l) return 'never';
  const at = shortWhen(Date.parse(l.due_at ?? l.at));
  return `${l.status} ${at}${l.kind === 'manual' ? ' (run now)' : l.late_min > 2 && l.status !== 'missed' ? ` (${l.late_min} min late)` : ''}`;
}

// `routine list` in words: the channels of a list ({ channels: [{ name, routines (as showRoutine), queued }] }).
export function listText(out, { cli = 'channels' } = {}) {
  const lines = [];
  for (const c of out.channels) {
    if (!c.routines.length) continue;
    lines.push(`#${c.name}${c.queued ? `  (${c.queued} waiting for the chat)` : ''}`);
    for (const r of c.routines) {
      lines.push(`  ${r.name}  ${r.enabled ? 'on ' : 'off'}  ${r.label}  catch-up ${r.catchup_min} min  next ${r.next_at ? shortWhen(Date.parse(r.next_at)) : '-'}  last ${lastText(r)}${r.skipped ? `  skipped ${shortWhen(Date.parse(r.skipped.due_at))} (${r.skipped.why})` : ''}`);
      lines.push(`    ${JSON.stringify(cut(oneLine(r.prompt), 100))}`);
    }
  }
  if (!lines.length) lines.push(`No routines yet. Add one with: ${cli} routine add <channel> <name> --schedule "weekdays 09:00" <prompt>`);
  return lines.join('\n');
}

// The chat prompt's paragraph on routines, for channel `name`.
export function promptText({ name, who = 'the user', where = 'this Mac', cli = 'channels' }) {
  return [
    `Routines: prompts this chat gets on a schedule, set up by ${who}. When one comes due, a message opening with "[routine <name>, scheduled <time>]" arrives here on its own, from the channels timer on ${where}, with the prompt between <routine-prompt> markers; it says "running <time>" too when it runs late because the timer couldn't run it on time. Do what its prompt asks. When ${who} asks for something recurring ("every weekday at 9, ask me for my plan"), set it up:`,
    `- \`${cli} routine add ${name} <name> --schedule "<schedule>" [--catchup <window>] -\`, with the prompt on stdin. <name> is short, lowercase, with dashes (morning-plan). Schedules are in ${where}'s local time: "weekdays 09:00", "daily 18:30", "hourly :15", "weekly fri 16:00", a cron line "cron 0 9 * * 1-5", or "manual" for one ${who} only runs by hand. The catch-up window (default 15 minutes for several runs a day, 1 hour for daily, 4 hours for weekly; 15m, 2h, 1d, 0) is how late a run the timer missed (${where} asleep or off) may still happen. Write the prompt as ${who} would ask it of you at that time, standing on its own.`,
    `- \`${cli} routine list ${name}\` shows them with their next and last runs; \`${cli} routine edit ${name} <name> [--schedule ...] [--catchup ...] [--prompt -] [--on|--off]\`, \`${cli} routine on|off|rm ${name} <name>\` change them and \`${cli} routine run ${name} <name>\` runs one now. A run that comes due while the last one still waits for this chat is skipped, not stacked. Change routines only when ${who} asks, and tell them the schedule and next run you set.`,
  ].join('\n');
}
