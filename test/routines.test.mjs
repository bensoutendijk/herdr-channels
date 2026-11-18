// Routines: schedule parsing, which runs are due, the catch-up window, no double fire, the routine commands, and a
// routine starting a chat that isn't running, against a fake home with stand-ins for `claude` and `hc`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { due, lastDue, matches, nextDue, ON_TIME_MS, parseCron, parseSchedule, ScheduleError } from '../bin/schedule.mjs';

const cli = fileURLToPath(new URL('../bin/channels.mjs', import.meta.url));
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;

// ---------- schedules ----------

test('presets and cron lines parse to a normalized schedule, in words too', () => {
  const cases = [
    ['weekdays 9:00', 'weekdays 09:00', 'Weekdays at 09:00', '0 9 * * 1-5'],
    ['Weekdays at 9am', 'weekdays 09:00', 'Weekdays at 09:00', '0 9 * * 1-5'],
    ['daily 18:30', 'daily 18:30', 'Every day at 18:30', '30 18 * * *'],
    ['every day at 6:05pm', 'daily 18:05', 'Every day at 18:05', '5 18 * * *'],
    ['daily 12am', 'daily 00:00', 'Every day at 00:00', '0 0 * * *'],
    ['hourly', 'hourly :00', 'Every hour at :00', '0 * * * *'],
    ['hourly :15', 'hourly :15', 'Every hour at :15', '15 * * * *'],
    ['weekly fri 16:00', 'weekly fri 16:00', 'Fridays at 16:00', '0 16 * * 5'],
    ['weekly on Sunday at 8', 'weekly sun 08:00', 'Sundays at 08:00', '0 8 * * 0'],
    ['cron 0 9 * * 1-5', 'cron 0 9 * * 1-5', 'Cron 0 9 * * 1-5', '0 9 * * 1-5'],
    ['*/15 9-17 * * mon-fri', 'cron */15 9-17 * * mon-fri', 'Cron */15 9-17 * * mon-fri', '*/15 9-17 * * mon-fri'],
  ];
  for (const [raw, spec, label, cron] of cases) {
    const s = parseSchedule(raw);
    assert.deepEqual([s.spec, s.label, s.cron.text], [spec, label, cron], raw);
    assert.deepEqual(parseSchedule(s.spec).spec, spec, `${raw}: the normalized form parses to itself`);
  }
  const c = parseCron('*/15 9-17 1,15 jan-mar 0,7');
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour].length, 9);
  assert.deepEqual([...c.day], [1, 15]);
  assert.deepEqual([...c.month], [1, 2, 3]);
  assert.deepEqual([...c.weekday], [0], '0 and 7 are both Sunday');
});

test('a schedule that makes no sense is refused with a message saying what is wrong', () => {
  for (const [raw, said] of [
    ['', /isn't a schedule/], ['sometimes', /isn't a schedule/], ['weekdays 25:00', /isn't a time/], ['daily 9:75', /isn't a time/],
    ['daily 13pm', /hour is 1 to 12/], ['hourly :60', /isn't a minute/], ['weekly someday 9:00', /isn't a day/],
    ['cron 0 9 * *', /5 fields/], ['cron 60 9 * * *', /Minute "60"/], ['cron 0 9 * * 1-5x', /Weekday "1-5x"/], ['cron 0 9 32 * *', /Day "32"/],
    ['cron 0 9 * 13 *', /Month "13"/], ['cron 0 9 * * 5-1', /Weekday "5-1"/], ['cron */0 * * * *', /Minute/],
  ]) assert.throws(() => parseSchedule(raw), (err) => err instanceof ScheduleError && said.test(err.message), raw);
});

test('the next and last run follow the schedule in local time, weekends and month ends included', () => {
  const weekdays = parseSchedule('weekdays 09:00').cron;
  // Friday 2026-11-20 10:00: the next is Monday 09:00, the last today's 09:00.
  assert.equal(nextDue(weekdays, at(2026, 11, 20, 10)), at(2026, 11, 23, 9));
  assert.equal(lastDue(weekdays, at(2026, 11, 20, 10)), at(2026, 11, 20, 9));
  // Sunday: the last was Friday.
  assert.equal(lastDue(weekdays, at(2026, 11, 22, 12)), at(2026, 11, 20, 9));
  // At exactly 09:00 it is due now, not next.
  assert.equal(lastDue(weekdays, at(2026, 11, 23, 9)), at(2026, 11, 23, 9));
  assert.equal(nextDue(weekdays, at(2026, 11, 23, 9)), at(2026, 11, 24, 9));
  // Nothing after `after`: none.
  assert.equal(lastDue(weekdays, at(2026, 11, 20, 10), at(2026, 11, 20, 9)), null);
  const hourly = parseSchedule('hourly :15').cron;
  assert.equal(nextDue(hourly, at(2026, 12, 31, 23, 20)), at(2027, 1, 1, 0, 15));
  const monthEnd = parseCron('0 8 31 * *');
  assert.equal(nextDue(monthEnd, at(2026, 11, 1)), at(2026, 12, 31, 8));
  // Day of month and weekday both given: either one counts.
  const either = parseCron('0 8 1 * mon');
  assert.ok(matches(either, at(2026, 12, 1, 8)) && matches(either, at(2026, 11, 23, 8)) && !matches(either, at(2026, 11, 24, 8)));
});

// ---------- which runs are due, and the catch-up window ----------

test('a routine is due on time, late within its catch-up window, and missed outside it; missed runs never stack', () => {
  const cron = parseSchedule('weekdays 09:00').cron;
  const since = new Date(at(2026, 11, 16, 8)).toISOString(); // Monday 08:00
  // Before 09:00 nothing; at 09:00 and up to the on-time margin it fires on time.
  assert.equal(due({ cron, since, catchupMin: 0, now: at(2026, 11, 16, 8, 59) }), null);
  assert.deepEqual(due({ cron, since, catchupMin: 0, now: at(2026, 11, 16, 9) }), { slot: at(2026, 11, 16, 9), late_ms: 0, action: 'fire' });
  assert.equal(due({ cron, since, catchupMin: 0, now: at(2026, 11, 16, 9) + ON_TIME_MS }).action, 'fire');
  // The Mac slept through 09:00 and wakes at 10:40: within a 2-hour window it fires late, outside a 1-hour one it's missed.
  assert.deepEqual(due({ cron, since, catchupMin: 120, now: at(2026, 11, 16, 10, 40) }), { slot: at(2026, 11, 16, 9), late_ms: 100 * MIN, action: 'fire' });
  assert.deepEqual(due({ cron, since, catchupMin: 60, now: at(2026, 11, 16, 10, 40) }), { slot: at(2026, 11, 16, 9), late_ms: 100 * MIN, action: 'missed' });
  // Once handled (done), the same time isn't due again.
  assert.equal(due({ cron, since, done: new Date(at(2026, 11, 16, 9)).toISOString(), catchupMin: 120, now: at(2026, 11, 16, 10, 40) }), null);
  // Asleep Monday to Wednesday 09:30: only Wednesday's run counts, and fires once, 30 minutes late.
  assert.deepEqual(due({ cron, since, catchupMin: 60, now: at(2026, 11, 18, 9, 30) }), { slot: at(2026, 11, 18, 9), late_ms: 30 * MIN, action: 'fire' });
  // A routine made (or switched on) after today's time waits for the next one.
  assert.equal(due({ cron, since: new Date(at(2026, 11, 16, 9, 5)).toISOString(), catchupMin: 60, now: at(2026, 11, 16, 9, 30) }), null);
});

// ---------- the commands, the tick and the chat ----------

// hc as the tests need it: terminals by name (hc-terms.json), `run` records its argv and makes a live terminal,
// `send` records what was typed, `attach` records where it went.
const FAKE_HC = (home) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = ${JSON.stringify(home)};
const args = process.argv.slice(2);
const file = path.join(home, 'hc-terms.json');
const terms = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const log = (f, x) => fs.appendFileSync(path.join(home, f), JSON.stringify(x) + '\\n');
const legacy = path.join(home, 'hc-legacy.json'); // terminals as an earlier version left them: { address: argv }
if (args[0] === 'ls') { const l = fs.existsSync(legacy) ? JSON.parse(fs.readFileSync(legacy, 'utf8')) : {}; process.stdout.write(JSON.stringify({ terminals: Object.keys(l).map((a) => ({ address: a, state: 'live' })) })); process.exit(0); }
if (args[0] === 'get' && fs.existsSync(legacy) && JSON.parse(fs.readFileSync(legacy, 'utf8'))[args[1]]) { process.stdout.write(JSON.stringify({ address: args[1], state: 'live', argv: JSON.parse(fs.readFileSync(legacy, 'utf8'))[args[1]] })); process.exit(0); }
// terms: name -> { address, argv, state }; a lost terminal is one the test turned into a shell, a killed one has finished.
const save = () => fs.writeFileSync(file, JSON.stringify(terms));
if (args[0] === 'get') {
  const t = terms[args[1]];
  process.stdout.write(JSON.stringify(t ? { address: t.address, name: args[1], argv: t.argv, state: t.state, status: 'idle' } : { address: args[1], status: 'idle' })); process.exit(0);
}
if (args[0] === 'kill') {
  for (const t of Object.values(terms)) if (t.address === args[1]) t.state = 'finished';
  save(); log('hc-kills.jsonl', { terminal: args[1] }); process.exit(0);
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  if (terms[name]?.state === 'live') { process.stderr.write(JSON.stringify({ error: { kind: 'name_taken' } })); process.exit(1); }
  const argv = args.slice(args.indexOf('--') + 1);
  const count = path.join(home, 'hc-count'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));
  terms[name] = { address: 't' + (n + 10), argv, state: 'live' };
  save();
  log('hc-runs.jsonl', { argv, name, cwd: args[args.indexOf('--cwd') + 1] });
  process.stdout.write(JSON.stringify({ address: terms[name].address, name, state: 'live' })); process.exit(0);
}
if (args[0] === 'send') { log('hc-sends.jsonl', { terminal: args[1], text: args[2] }); process.exit(0); }
if (args[0] === 'attach') { log('hc-attach.jsonl', { terminal: args[1] }); process.exit(0); }
process.exit(2);
`;

// claude as a chat: records its launch and stays up until the listener has typed what the test waits for.
const FAKE_CLAUDE = (home) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = ${JSON.stringify(home)};
const args = process.argv.slice(2);
if (args[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }
fs.appendFileSync(path.join(home, 'chat-launches.jsonl'), JSON.stringify({ args, dir: process.env.CHANNELS_DIR }) + '\\n');
const want = Number(process.env.FAKE_WAIT_SENDS || 0);
const sends = () => { const f = path.join(home, 'hc-sends.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).length : 0; };
const until = Date.now() + 15000;
const t = setInterval(() => { if (sends() >= want || Date.now() > until) { clearInterval(t); process.exit(0); } }, 50);
`;

function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'routines-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const projects = join(home, 'projects');
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'hc'), FAKE_HC(home));
  writeFileSync(join(home, 'bin', 'claude'), FAKE_CLAUDE(home));
  chmodSync(join(home, 'bin', 'hc'), 0o755);
  chmodSync(join(home, 'bin', 'claude'), 0o755);
  const dir = join(home, 'store');
  const env = (extra = {}) => ({
    ...process.env, HOME: home, CHANNELS_DIR: dir, CHANNELS_PROJECTS: projects, CHANNELS_MACHINE: 'testmac',
    CHANNELS_CLAUDE: join(home, 'bin', 'claude'), CHANNELS_HC: join(home, 'bin', 'hc'), HC_TERMINAL_ID: '', CHANNELS_BIN: '', ...extra,
  });
  const run = (args, input, extra) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, env: env(extra), timeout: 30000 });
  const ok = (args, input, extra) => { const r = run(args, input, extra); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout; };
  const lines = (f) => (existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const store = () => JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8'));
  // One tick at a given time, in its own process, the way launchd runs it (with `now` fixed for the test).
  const tickAt = (now) => new Promise((done) => {
    const code = `import(${JSON.stringify(cli)}).then(async (m) => { const r = await m.tick({ dir: ${JSON.stringify(dir)}, deps: m.defaultDeps(${JSON.stringify(home)}), now: ${now} }); process.stdout.write(JSON.stringify(r)); })`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: env() });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => done(JSON.parse(out || '{}')));
  });
  return { home, dir, projects, run, ok, lines, store, tickAt, env };
}

const nextNine = () => { const d = new Date(); d.setHours(9, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); }; // the next 09:00, today or tomorrow

test('routine add, list, edit, on, off and rm keep a routine in the channel\'s store', (t) => {
  const { ok, run, store } = setup(t);
  ok(['create', 'general']);
  assert.match(ok(['routine', 'add', 'general', 'Morning-Plan', '--schedule', 'weekdays 9am', 'Ask me for my plan.']), /Added a routine to #general: morning-plan: Weekdays at 09:00, next .*catch-up 60 min/);
  assert.match(run(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 9:00', 'x']).stderr, /already has a routine/);
  assert.match(run(['routine', 'add', 'general', 'x', '--schedule', 'weekdays 25:00', 'x']).stderr, /isn't a time/);
  assert.match(run(['routine', 'add', 'general', 'x', '--schedule', 'daily 9:00']).stderr, /needs a prompt/);
  ok(['routine', 'add', 'general', 'review', '--schedule', 'cron 0 16 * * fri', '--catchup', '2h', '--off', '-'], 'Summarise the week.\n');
  const [r1, r2] = store().channels[0].routines;
  assert.deepEqual([r1.name, r1.schedule, r1.catchup_min, r1.enabled, r1.prompt], ['morning-plan', 'weekdays 09:00', 60, true, 'Ask me for my plan.']);
  assert.deepEqual([r2.name, r2.schedule, r2.catchup_min, r2.enabled, r2.prompt], ['review', 'cron 0 16 * * fri', 120, false, 'Summarise the week.']);
  const listed = JSON.parse(ok(['routine', 'list', '--json'])).channels[0].routines;
  assert.equal(listed[0].label, 'Weekdays at 09:00');
  assert.ok(Date.parse(listed[0].next_at) > Date.now());
  assert.equal(listed[1].next_at, null, 'an off routine has no next run');
  ok(['routine', 'edit', 'general', 'review', '--schedule', 'weekly fri 17:00', '--catchup', '0', '--prompt', 'New words.', '--rename', 'weekly-review']);
  ok(['routine', 'on', 'general', 'weekly-review']);
  const r3 = store().channels[0].routines[1];
  assert.deepEqual([r3.name, r3.schedule, r3.catchup_min, r3.enabled, r3.prompt], ['weekly-review', 'weekly fri 17:00', 0, true, 'New words.']);
  assert.ok(Date.parse(r3.since) > Date.parse(r2.since), 'switching on or rescheduling starts it afresh');
  assert.match(ok(['routine', 'list']), /weekly-review {2}on +Fridays at 17:00/);
  ok(['routine', 'off', 'general', 'morning-plan']);
  ok(['routine', 'rm', 'general', 'weekly-review']);
  assert.deepEqual(store().channels[0].routines.map((r) => [r.name, r.enabled]), [['morning-plan', false]]);
  assert.match(run(['routine', 'rm', 'general', 'nope']).stderr, /has no routine "nope"/);
  // list --json shows each channel's routines for the mod's clock mark.
  assert.equal(JSON.parse(ok(['list', '--json'])).channels[0].routines.length, 1);
});

test('a tick fires a due routine once into a running chat, marked as a routine; the listener types it in', async (t) => {
  const { ok, dir, store, tickAt, lines, run } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 09:00', 'Ask me for my plan.']);
  const c = store().channels[0];
  // The chat is running in terminal t7 (its record, as `channels chat` writes it, with a live pid).
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  writeFileSync(join(dir, `chat-${c.id}.json`), JSON.stringify({ pid: sleeper.pid, terminal: 't7', session_id: 'x' }));
  const nine = nextNine();
  assert.deepEqual((await tickAt(nine - MIN)).runs, [], 'not yet');
  const fired = await tickAt(nine + 30_000);
  assert.deepEqual(fired.runs.map((x) => [x.routine, x.action]), [['morning-plan', 'fire']]);
  assert.deepEqual((await tickAt(nine + 90_000)).runs, [], 'the same run never fires twice');
  assert.equal(lines('hc-runs.jsonl').length, 0, 'a running chat isn\'t started again');
  const s = store().channels[0];
  assert.equal(s.queue.length, 1);
  assert.match(s.queue[0].text, /^\[routine morning-plan, scheduled 09:00\] #general\n/);
  assert.match(s.queue[0].text, /<routine-prompt>\nAsk me for my plan.\n<\/routine-prompt>/);
  assert.doesNotMatch(s.queue[0].text, /running/);
  assert.deepEqual([s.routines[0].last.status, s.routines[0].last.kind, s.routines[0].done], ['queued', 'scheduled', new Date(nine).toISOString()]);
  // The listener's look types it into the chat's terminal and marks it delivered.
  const out = run(['listen', 'general', '--once']).stdout;
  assert.match(out, /\[routine morning-plan, scheduled 09:00\]/);
  const after = store().channels[0];
  assert.deepEqual([after.queue.length, after.routines[0].last.status], [0, 'delivered']);
});

test('ticks at the same moment never fire a routine twice', async (t) => {
  const { ok, store, tickAt } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'a', '--schedule', 'daily 09:00', 'A.']);
  ok(['routine', 'add', 'general', 'b', '--schedule', 'hourly', 'B.']);
  const now = nextNine() + 20_000;
  const results = await Promise.all(Array.from({ length: 8 }, () => tickAt(now)));
  const fired = results.flatMap((r) => r.runs ?? []).filter((x) => x.action === 'fire').map((x) => x.routine).sort();
  assert.deepEqual(fired, ['a', 'b']);
  assert.deepEqual(store().channels[0].queue.map((m) => m.name).sort(), ['a', 'b']);
});

test('a run the Mac slept through fires late inside the catch-up window and says so; outside it, it is recorded as missed', async (t) => {
  const { ok, store, tickAt } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'wide', '--schedule', 'daily 09:00', '--catchup', '2h', 'Wide.']);
  ok(['routine', 'add', 'general', 'narrow', '--schedule', 'daily 09:00', '--catchup', '1h', 'Narrow.']);
  // The Mac wakes at 10:40, two days after the routines were made: only that day's 09:00 counts.
  const w = new Date(nextNine()); w.setDate(w.getDate() + 1); w.setHours(10, 40, 0, 0);
  const wake = w.getTime();
  const r = await tickAt(wake);
  assert.deepEqual(r.runs.map((x) => [x.routine, x.action, x.late_min]).sort(), [['narrow', 'missed', 100], ['wide', 'fire', 100]]);
  const c = store().channels[0];
  assert.equal(c.queue.length, 1, 'missed runs never stack');
  assert.match(c.queue[0].text, /^\[routine wide, scheduled 09:00, running 10:40\] #general/);
  assert.match(c.queue[0].text, /It is late: it was due at 09:00 and runs at 10:40/);
  const narrow = c.routines.find((x) => x.name === 'narrow');
  assert.deepEqual([narrow.last.status, narrow.last.late_min], ['missed', 100]);
  assert.deepEqual((await tickAt(wake + MIN)).runs, [], 'a missed run is recorded once, and not retried');
});

test('a routine whose chat isn\'t running starts it in the background, where its listener types the prompt in; opening the chat attaches to it', async (t) => {
  const { ok, dir, home, store, tickAt, lines, env } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 09:00', 'Ask me for my plan.']);
  const c = store().channels[0];
  await tickAt(nextNine());
  // The tick started one herdr-core terminal named after the channel, running this command's chat.
  const [started] = lines('hc-runs.jsonl');
  assert.equal(started.name, `chat-${c.id}`);
  assert.deepEqual(started.argv.slice(-2), ['chat', 'general']);
  assert.ok(started.argv.includes(`CHANNELS_DIR=${dir}`));
  // Another tick, or the mod opening the chat, while it comes up: the same terminal, not a second one.
  assert.deepEqual(JSON.parse(ok(['chat', 'general', '--bg', '--json'])), { address: 't10', started: false });
  assert.equal(lines('hc-runs.jsonl').length, 1);
  // Run what the tick started, in that terminal: the chat launches and its listener types the routine in.
  const r = spawnSync(started.argv[0], started.argv.slice(1), { encoding: 'utf8', env: env({ HC_TERMINAL_ID: 't10', FAKE_WAIT_SENDS: '1' }), timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines('chat-launches.jsonl').length, 1);
  const [sent] = lines('hc-sends.jsonl');
  assert.equal(sent.terminal, 't10');
  assert.match(sent.text, /^\[routine morning-plan, scheduled 09:00\]/);
  assert.equal(store().channels[0].routines[0].last.status, 'delivered');
  // While that chat runs, `channels chat` elsewhere attaches to its terminal instead of starting a second claude.
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  writeFileSync(join(dir, `chat-${c.id}.json`), JSON.stringify({ pid: sleeper.pid, terminal: 't10', session_id: 'x' }));
  ok(['chat', 'general'], '', { HC_TERMINAL_ID: 't99' });
  assert.deepEqual(lines('hc-attach.jsonl'), [{ terminal: 't10' }]);
  assert.equal(lines('chat-launches.jsonl').length, 1);
  assert.deepEqual(JSON.parse(ok(['list', '--json'])).channels[0].chat_terminal, 't10');
  assert.ok(existsSync(join(dir, 'tick.log')) && /started #general's chat in the background in t10/.test(readFileSync(join(dir, 'tick.log'), 'utf8')));
  assert.ok(home);
});

test('a chat whose terminal ended, or that herdr-core replaced with a shell, is started again; the shell is ended first', (t) => {
  const { ok, home, lines } = setup(t);
  ok(['create', 'general']);
  assert.deepEqual(JSON.parse(ok(['chat', 'general', '--bg', '--json'])), { address: 't10', started: true });
  const terms = () => JSON.parse(readFileSync(join(home, 'hc-terms.json'), 'utf8'));
  const edit = (fn) => { const all = terms(); for (const x of Object.values(all)) fn(x); writeFileSync(join(home, 'hc-terms.json'), JSON.stringify(all)); };
  // Still running the chat: the same terminal.
  assert.deepEqual(JSON.parse(ok(['chat', 'general', '--bg', '--json'])), { address: 't10', started: false });
  // The core lost it (an update, a restart) and gave its address and name a shell: that isn't the chat.
  edit((x) => { x.argv = ['/bin/zsh', '-l']; });
  assert.deepEqual(JSON.parse(ok(['chat', 'general', '--bg', '--json'])), { address: 't11', started: true, replaced: 't10' });
  assert.deepEqual(lines('hc-kills.jsonl'), [{ terminal: 't10' }]);
  assert.deepEqual(lines('hc-runs.jsonl').map((r) => r.argv.slice(-2)), [['chat', 'general'], ['chat', 'general']]);
  // /exit: the terminal finished. A new one starts, and there is nothing to end.
  edit((x) => { x.state = 'finished'; });
  assert.deepEqual(JSON.parse(ok(['chat', 'general', '--bg', '--json'])), { address: 't12', started: true });
  assert.equal(lines('hc-kills.jsonl').length, 1);
});

test('a chat opened by an earlier version (no record, no inbox in its listener) gets the routine typed in by the tick, not a second chat', async (t) => {
  const { ok, home, store, tickAt, lines } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 09:00', 'Ask me for my plan.']);
  writeFileSync(join(home, 'hc-legacy.json'), JSON.stringify({ t3: ['zsh'], t5: ['sh', '-c', 'PATH="$0:$PATH" exec "$@"', '/x', '/home/.local/bin/channels', 'chat', 'general'] }));
  await tickAt(nextNine());
  assert.equal(lines('hc-runs.jsonl').length, 0);
  const [sent] = lines('hc-sends.jsonl');
  assert.equal(sent.terminal, 't5');
  assert.match(sent.text, /^\[routine morning-plan, scheduled 09:00\]/);
  const c = store().channels[0];
  assert.deepEqual([c.queue.length, c.routines[0].last.status], [0, 'delivered']);
});

test('routine preview says a schedule in words with its next runs, or what is wrong with it', (t) => {
  const { ok, run } = setup(t);
  const p = JSON.parse(ok(['routine', 'preview', 'weekly', 'fri', '16:00', '--json']));
  assert.equal(p.label, 'Fridays at 16:00');
  assert.equal(p.next.length, 3);
  assert.ok(p.next.every((x) => new Date(x).getDay() === 5 && new Date(x).getHours() === 16));
  assert.match(JSON.parse(ok(['routine', 'preview', 'cron 0 9 * * 1-5x', '--json'])).error, /Weekday "1-5x"/);
  assert.equal(run(['routine', 'preview', 'nonsense']).status, 1);
});

test('run now sends the prompt at once, marked as run now, and leaves the schedule alone', (t) => {
  const { ok, store, lines } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 09:00', 'Ask me for my plan.']);
  assert.match(ok(['routine', 'run', 'general', 'morning-plan']), /started in the background \(terminal t10\)/);
  const c = store().channels[0];
  assert.match(c.queue[0].text, /^\[routine morning-plan, run now\] #general/);
  assert.deepEqual([c.routines[0].last.kind, c.routines[0].last.status, c.routines[0].done], ['manual', 'queued', null]);
  assert.equal(lines('hc-runs.jsonl').length, 1);
});

test('the chat prompt tells the chat how to set up a routine when the user asks', async () => {
  const { chatPrompt } = await import('../bin/channels.mjs');
  const p = chatPrompt(mkdtempSync(join(tmpdir(), 'routines-p-')), 'general', { projects: '/p' });
  for (const s of ['channels routine add general <name> --schedule', '"weekdays 09:00"', 'cron 0 9 * * 1-5', '[routine <name>, scheduled <time>]', 'channels routine run general <name>', 'local time']) assert.ok(p.includes(s), s);
});
