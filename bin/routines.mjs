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
import { defaultCatchup, due, MANUAL_LABEL, nextDue, parseSchedule, ScheduleError, scheduleWarnings, shortWhen, timeZone } from './schedule.mjs';

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

// The message a routine types into the chat. The header says it is a routine, when it was due, and when it runs if
// that is late: "[routine morning-plan, scheduled 09:00, running 10:40]".
export function routineText({ channel, routine, slot = null, now = Date.now(), manual = false, label = null, who = 'the user', where = 'this Mac' }) {
  if (label == null) { try { label = parseSchedule(routine.schedule).label; } catch { label = routine.schedule; } }
  const late = !manual && slot != null && now - slot > 2 * 60_000;
  const head = manual ? `[routine ${routine.name}, run now]` : `[routine ${routine.name}, scheduled ${shortWhen(slot, now)}${late ? `, running ${hm(now)}` : ''}]`;
  const lines = [
    `${head} #${channel}`,
    manual
      ? `From the channels timer on ${where}: ${who} asked for this routine of #${channel} to run now.`
      : `From the channels timer on ${where}, not typed by ${who} just now: a routine ${who} set up for #${channel} came due (${label}).`,
  ];
  if (late) lines.push(`It is late: it was due at ${shortWhen(slot, now)} and runs at ${hm(now)}, because the timer on ${where} couldn't run it then (asleep or off).`);
  lines.push('', `The routine's prompt, as ${who} wrote it:`, '<routine-prompt>', fenceRoutine(routine.prompt), '</routine-prompt>', '',
    replyContract({ now, manual, who, where }));
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
  `${cli} routine add <channel> <name> --schedule <schedule> [--catchup <window>] [--off] [--dry-run] <prompt | ->`,
  `${cli} routine edit <channel> <name> [--schedule <schedule>] [--catchup <window>] [--prompt <text | ->] [--rename <new-name>] [--on | --off] [--dry-run]`,
  `${cli} routine rm|run|on|off <channel> <name>`,
  `${cli} routine preview <schedule> [--json]`,
  `Schedules (${where}'s local time): "weekdays 09:00", "daily 09:00", "hourly :15", "weekly fri 16:00", "cron <5 fields>", or "manual" (only when run).`,
  `--dry-run checks everything and prints what it would set up, headed "Would set up:", without saving.`,
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

// The chat prompt's paragraph on routines, for channel `name`: what a run looks like and how to answer it, how to set
// one up (rounding a request no schedule fits, a one-off, proposing with --dry-run, passing on the confirmation),
// and how to answer "why didn't it run?" from routine list --json.
export function promptText({ name, who = 'the user', where = 'this Mac', cli = 'channels' }) {
  return [
    `Routines: prompts this chat gets on a schedule, set up by ${who}. When one comes due, a message opening with "[routine <name>, scheduled <time>]" arrives here on its own, from the channels timer on ${where}, with the prompt between <routine-prompt> markers; it says "running <time>" too when it runs late because the timer couldn't run it on time. Do what its prompt asks, and answer the way its "For you" lines say: one plain line with the outcome first (a run with nothing for ${who} stops there), the prompt's own limits on day and time checked against the day and time the message gives, and a question only when you can't go on without one.`,
    `When ${who} asks for something recurring ("every weekday at 9, ask me for my plan"), set it up:`,
    `- \`${cli} routine add ${name} <name> --schedule "<schedule>" [--catchup <window>] -\`, with the prompt on stdin. <name> is short, lowercase, with dashes (morning-plan). Schedules are in ${where}'s local time: "weekdays 09:00", "daily 18:30", "hourly :15", "weekly fri 16:00", a cron line "cron 0 9 * * 1-5", or "manual" for one ${who} only runs by hand. The catch-up window (default 15 minutes for several runs a day, 1 hour for daily, 4 hours for weekly; 15m, 2h, 1d, 0) is how late a run the timer missed (${where} asleep or off) may still happen. Write the prompt as ${who} would ask it of you at that time, standing on its own.`,
    `- A request no schedule fits ("every 90 minutes", "the first Monday of the month", "every other Friday", "around lunch"): pick the nearest schedule that does, and say what you chose and why. Limits a schedule can't hold ("only the first Monday", "skip holidays") go in the prompt, which the run checks against the date. In a cron line with both a day of the month and a weekday, a day matching either one runs.`,
    `- Something once ("remind me at 3 tomorrow"): a routine on a cron line for that date and time ("cron 0 15 24 11 *"), with --catchup 1d so it still runs if ${where} was asleep, and a prompt that ends: "Then remove this routine: ${cli} routine rm ${name} <name>". It removes itself when it runs.`,
    `- add and edit take --dry-run: every check runs and the confirmation prints headed "Would set up:", with nothing saved. When you rounded a schedule, made a one-off or aren't sure what ${who} meant, propose it that way and set it up once ${who} agrees.`,
    `- add, edit, on and off print a short confirmation block (the routine, when in words, on or off, the next two runs, the catch-up, the prompt's first line, where to change it). Pass it on to ${who} as it is, in a code block, not retold.`,
    `- \`${cli} routine list ${name}\` shows them with their next and last runs; \`${cli} routine edit ${name} <name> [--schedule ...] [--catchup ...] [--prompt -] [--on|--off]\`, \`${cli} routine on|off|rm ${name} <name>\` change them and \`${cli} routine run ${name} <name>\` runs one now. A run that comes due while the last one still waits for this chat is skipped, not stacked. Change routines only when ${who} asks.`,
    `When ${who} asks why a routine didn't run (or ran late, or twice), read \`${cli} routine list ${name} --json\` rather than guess, and answer in plain words with the days and times. Each routine has: enabled (false: switched off, so nothing runs on schedule); next_at (its next run; null when off or manual); error (its schedule no longer reads); last, its most recent run, with due_at, at, late_min, kind (scheduled or manual, a run now) and status: queued (waiting to be typed into this chat, which was busy or not running), delivered (typed into this chat at delivered_at), missed (it came due while ${where} was asleep or off and the timer got to it after the catch-up window, catchup_min, had passed, so it didn't run), dropped (it was waiting when the routine was switched off); and skipped (a later time came due while a run still waited for this chat, so it was skipped, count times, the last at skipped.due_at). The channel's queued counts runs still waiting. A new schedule or switching on starts afresh: times before that are neither run nor missed.`,
  ].join('\n');
}
