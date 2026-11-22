// Routines: schedule parsing, which runs are due, the catch-up window, no double fire, the routine commands, and a
// routine starting a chat that isn't running, against a fake home with stand-ins for `claude` and `hc`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCatchup, describeCron, due, lastDue, matches, nextDue, ON_TIME_MS, parseCron, parseSchedule, ScheduleError, scheduleWarnings, skippedTimes } from '../bin/schedule.mjs';

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
    ['cron 0 9 * * 1-5', 'cron 0 9 * * 1-5', 'Weekdays at 09:00', '0 9 * * 1-5'],
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
if (args[0] === '--version') { process.stdout.write('2.1.329 (Claude Code)\\n'); process.exit(0); }
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
  assert.match(ok(['routine', 'add', 'general', 'Morning-Plan', '--schedule', 'weekdays 9am', 'Ask me for my plan.']), /^Added a routine to #general:\n {2}Routine: {3}morning-plan in #general\n {2}When: {6}Weekdays at 09:00, this Mac's time\n {2}Status: {4}on\n {2}Next runs: (Mon|Tue|Wed|Thu|Fri) \w{3} \d+, 09:00 and (Mon|Tue|Wed|Thu|Fri) .*\n {2}Catch-up: {2}runs up to 1 hour late .*\n {2}Prompt: {4}"Ask me for my plan\."\n {2}To change: .*channels routine edit general morning-plan/);
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
  assert.match(s.queue[0].text, new RegExp(`^\\[routine morning-plan · scheduled (\w+ )?09:00 · run ${c.routines[0].id}@${new Date(nine).toISOString().replace(/\./g, '\\.')}\\] #general\n`));
  assert.equal(s.queue[0].id, `${c.routines[0].id}@${new Date(nine).toISOString()}`, 'a run\'s id is its routine and slot');
  assert.deepEqual([s.queue[0].scheduled_for, s.queue[0].prompt, s.queue[0].first], [new Date(nine).toISOString(), 'Ask me for my plan.', true]);
  assert.match(s.queue[0].text, /<routine-prompt>\nAsk me for my plan.\n<\/routine-prompt>/);
  assert.doesNotMatch(s.queue[0].text, /running/);
  assert.deepEqual([s.routines[0].last.status, s.routines[0].last.kind, s.routines[0].done], ['queued', 'scheduled', new Date(nine).toISOString()]);
  // The listener's look types it into the chat's terminal and marks it delivered.
  const out = run(['listen', 'general', '--once']).stdout;
  assert.match(out, /\[routine morning-plan · scheduled (\w+ )?09:00 · run rt_/);
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
  assert.match(c.queue[0].text, /^\[routine wide · scheduled 09:00, running 10:40 · run rt_\w+@[^\]]+\] #general/);
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
  assert.match(sent.text, /^\[routine morning-plan · scheduled (\w+ )?09:00 · run /);
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
  assert.match(sent.text, /^\[routine morning-plan · scheduled (\w+ )?09:00 · run /);
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
  assert.match(c.queue[0].text, /^\[routine morning-plan · run now · run rt_\w+@manual-[^\]]+\] #general/);
  assert.deepEqual([c.routines[0].last.kind, c.routines[0].last.status, c.routines[0].done], ['manual', 'queued', null]);
  assert.equal(lines('hc-runs.jsonl').length, 1);
});

test('the chat prompt tells the chat how to set up a routine when the user asks', async () => {
  const { chatPrompt } = await import('../bin/channels.mjs');
  const p = chatPrompt(mkdtempSync(join(tmpdir(), 'routines-p-')), 'general', { projects: '/p' });
  for (const s of ['channels routine add general <name> --schedule', '"weekdays 09:00"', 'cron 0 9 * * 1-5', '[routine <name> · scheduled <time> · run <id>]', 'channels routine run general <name>', 'local time']) assert.ok(p.includes(s), s);
});

// ---------- the shared engine (bin/routines.mjs) and its fixes ----------

test('bin/routines.mjs touches no file or process: it imports only ./schedule.mjs and node:crypto, so it can be vendored beside schedule.mjs', () => {
  const src = readFileSync(fileURLToPath(new URL('../bin/routines.mjs', import.meta.url)), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./schedule.mjs', 'node:crypto']);
  assert.doesNotMatch(src, /process\.|require\(|import\(/);
});

test('a slot that comes due while a run of the routine still waits for the chat is skipped, not queued again', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'hourly-check', prompt: 'Check.', spec: 'hourly :00', now: at(2026, 11, 23, 8, 30) });
  const store = { channels: [c] };
  const tickAt = (h) => R.claimDue(store, at(2026, 11, 23, h) + 30_000);
  assert.deepEqual(tickAt(9).map((x) => x.action), ['fire']);
  // The chat stays busy: 10:00 and 11:00 come due with the 09:00 run still waiting.
  assert.deepEqual(tickAt(10).map((x) => [x.action, x.due_at]), [['skip', new Date(at(2026, 11, 23, 10)).toISOString()]]);
  tickAt(11);
  assert.equal(c.queue.length, 1, 'one message waits, not three');
  const r = c.routines[0];
  assert.deepEqual([r.last.status, r.skipped.count, r.skipped.why], ['queued', 2, 'already waiting for the chat']);
  assert.equal(R.showRoutine(r).skipped.due_at, new Date(at(2026, 11, 23, 11)).toISOString());
  assert.equal(R.claimLine({ channel: 'general', routine: 'hourly-check', action: 'skip', due_at: 'x', late_min: 0 }), 'skipped #general hourly-check due x: already waiting for the chat');
  // Once the chat has it, the next slot fires again.
  R.markDelivered(c, c.queue[0].id, at(2026, 11, 23, 11, 30));
  assert.equal(r.last.status, 'delivered');
  assert.deepEqual(tickAt(12).map((x) => x.action), ['fire']);
  assert.equal(r.skipped, null);
});

test('switching a routine off drops its scheduled runs still waiting for the chat, keeps a run now, and says so', async (t) => {
  const { ok, store, tickAt } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 09:00', 'Ask me for my plan.']);
  await tickAt(nextNine() + 20_000);
  ok(['routine', 'run', 'general', 'morning-plan']);
  assert.deepEqual(store().channels[0].queue.map((e) => e.kind), ['scheduled', 'manual']);
  assert.match(ok(['routine', 'off', 'general', 'morning-plan']), /^Switched #general's routine morning-plan off:\n[^]*Status: {4}off: it won't run on its schedule[^]*Dropped: {3}1 run that was waiting for the chat$/m);
  assert.deepEqual(store().channels[0].queue.map((e) => e.kind), ['manual'], 'the run now stays: the user asked for it');
  // Off again with nothing scheduled waiting: nothing dropped, nothing said about it.
  assert.doesNotMatch(ok(['routine', 'off', 'general', 'morning-plan']), /Dropped/);
});

test('switching off marks a dropped scheduled run on the routine\'s last run, and an old entry with no kind counts as scheduled', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'a', prompt: 'A.', spec: 'daily 09:00', now: at(2026, 11, 23, 8) });
  R.claimDue({ channels: [c] }, at(2026, 11, 23, 9) + 30_000);
  delete c.queue[0].kind; // written by an earlier version
  const { routine, dropped } = R.editRoutine(c, 'a', { enabled: false }, at(2026, 11, 23, 9, 5));
  assert.deepEqual([dropped, c.queue.length, routine.last.status], [1, 0, 'dropped']);
  assert.equal(R.entryKind({ text: '[routine a, run now] #general\n…' }), 'manual');
});

test('routine edit takes --on or --off with the other fields, in one write; capabilities say so', (t) => {
  const { ok, run, store } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'review', '--schedule', 'daily 09:00', '--off', 'Review.']);
  const out = JSON.parse(ok(['routine', 'edit', 'general', 'review', '--schedule', 'weekly fri 16:00', '--prompt', 'Week.', '--on', '--json']));
  assert.deepEqual([out.enabled, out.schedule, out.dropped], [true, 'weekly fri 16:00', 0]);
  assert.deepEqual([store().channels[0].routines[0].enabled, store().channels[0].routines[0].prompt], [true, 'Week.']);
  ok(['routine', 'edit', 'general', 'review', '--off']);
  assert.equal(store().channels[0].routines[0].enabled, false);
  assert.match(run(['routine', 'edit', 'general', 'review', '--on', '--off']).stderr, /--on or --off, not both/);
  // A bad schedule with --on changes nothing: the switch doesn't land without the rest.
  assert.match(run(['routine', 'edit', 'general', 'review', '--schedule', 'weekdays 25:00', '--on']).stderr, /isn't a time/);
  assert.equal(store().channels[0].routines[0].enabled, false);
  assert.ok(JSON.parse(ok(['capabilities', '--json'])).features.includes('routine-edit-on'));
});

test('the routine words name who, where and which command a backend passes in', async () => {
  const R = await import('../bin/routines.mjs');
  const words = { who: 'Sam', where: 'server', cli: 'hub channels' };
  const p = R.promptText({ name: 'general', ...words });
  for (const s of ['hub channels routine add general <name>', 'set up by Sam', "server's local time", 'hub channels routine run general <name>', 'skipped, not stacked']) assert.ok(p.includes(s), s);
  assert.doesNotMatch(p, /this Mac|the user/);
  const text = R.routineText({ channel: 'general', routine: { name: 'x', prompt: 'P', schedule: 'daily 09:00' }, slot: at(2026, 11, 23, 9), now: at(2026, 11, 23, 10, 40), ...words });
  assert.match(text, /timer on server, not typed by Sam just now/);
  assert.match(text, /because the timer on server couldn't run it then/);
  assert.match(R.routineUsage(words), /^hub channels routine list/);
  assert.match(R.routineUsage(words), /\[--on \| --off\]/);
});

test('a cron line reads in words where it has a common shape, else as "Cron <line>"', () => {
  const cases = [
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri at 09:00'],
    ['0 9 * * 1-5', 'Weekdays at 09:00'],
    ['0 9,17 * * 1-5', 'Weekdays at 09:00 and 17:00'],
    ['30 8 * * sat,sun', 'Weekends at 08:30'],
    ['0 16 * * fri', 'Fridays at 16:00'],
    ['0 8 * * 7', 'Sundays at 08:00'],
    ['0 18 * * *', 'Every day at 18:00'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['* * * * *', 'Every minute'],
    ['15 * * * *', 'Every hour at :15'],
    ['0 */2 * * *', 'Every 2 hours at :00'],
    ['0 9 1 * *', 'The 1st of each month at 09:00'],
    ['0 9 1,15 * *', 'The 1st and 15th of each month at 09:00'],
    ['0 9 * 1 *', null], // a month restricted
    ['30 14 23 11 *', 'Nov 23 at 14:30, each year'], // one date: how a one-off is written
    ['30 14 23 11 1', null], // one date or Mondays
    ['0 9 1 * 1', null], // both day fields restricted: either matches
    ['*/15 9-17 * * mon-fri', null], // too many times to list
    ['5,10 * * * *', null],
  ];
  for (const [line, words] of cases) {
    assert.equal(describeCron(parseCron(line)), words, line);
    assert.equal(parseSchedule(`cron ${line}`).label, words ?? `Cron ${parseCron(line).text}`, line);
  }
  assert.equal(describeCron(null), null);
});

test('a manual schedule has no time: nothing comes due, and the tick leaves it alone', async (t) => {
  const s = parseSchedule('manual');
  assert.deepEqual([s.spec, s.cron, s.label, s.manual], ['manual', null, 'Only when you run it', true]);
  assert.equal(parseSchedule(' Manual ').spec, 'manual');
  assert.equal(nextDue(null, Date.now()), null);
  assert.equal(lastDue(null, Date.now()), null);
  assert.equal(matches(null, Date.now()), false);
  assert.equal(due({ cron: null, since: new Date(0).toISOString(), catchupMin: 1440, now: Date.now() }), null);
  assert.deepEqual(skippedTimes(null), []);
  assert.throws(() => parseSchedule('nonsense'), /or "manual"/);

  const { ok, store, tickAt } = setup(t);
  ok(['create', 'general']);
  assert.match(ok(['routine', 'add', 'general', 'release-notes', '--schedule', 'manual', 'Draft the release notes.']), /When: {6}Only when you run it \(no schedule\)\n {2}Status: {4}on\n {2}Runs: {6}only when run: Run now in Routines, or channels routine run general release-notes\n {2}Prompt/);
  const listed = JSON.parse(ok(['routine', 'list', 'general', '--json'])).channels[0].routines[0];
  assert.deepEqual([listed.schedule, listed.label, listed.next_at, listed.error], ['manual', 'Only when you run it', null, null]);
  assert.deepEqual((await tickAt(Date.now() + 86_400_000)).runs, [], 'a manual routine never comes due');
  assert.equal(store().channels[0].routines[0].last, null);
  const p = JSON.parse(ok(['routine', 'preview', 'manual', '--json']));
  assert.deepEqual([p.spec, p.label, p.manual, p.next, p.warnings], ['manual', 'Only when you run it', true, [], []]);
  assert.equal(ok(['routine', 'preview', 'manual']).trim(), 'Only when you run it.');
});

test('a new routine\'s catch-up window follows its schedule unless one is given', (t) => {
  const w = (spec) => defaultCatchup(parseSchedule(spec));
  assert.deepEqual(['hourly :15', 'cron */30 * * * *', 'cron 0 9,17 * * *', 'daily 09:00', 'weekdays 09:00', 'cron 0 9 * * 1,3,5', 'weekly fri 16:00', 'cron 0 9 1 * *', 'manual'].map(w),
    [15, 15, 15, 60, 60, 60, 240, 240, 60]);
  const { ok, store } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'sweep', '--schedule', 'hourly :15', 'Check the inbox.']);
  ok(['routine', 'add', 'general', 'review', '--schedule', 'weekly fri 16:00', 'Review the week.']);
  ok(['routine', 'add', 'general', 'kept', '--schedule', 'hourly', '--catchup', '2h', 'Kept.']);
  assert.deepEqual(store().channels[0].routines.map((r) => r.catchup_min), [15, 240, 120]);
  assert.equal(JSON.parse(ok(['routine', 'preview', 'hourly', '--json'])).catchup_min, 15);
});

test('preview names the time zone and warns of a time the clocks skip', (t) => {
  const { ok } = setup(t);
  const chicago = JSON.parse(ok(['routine', 'preview', 'daily 02:30', '--json'], undefined, { TZ: 'America/Chicago' }));
  assert.equal(chicago.tz, 'America/Chicago');
  assert.equal(chicago.warnings.length, 1);
  assert.match(chicago.warnings[0], /^02:30 doesn't happen on Mar \d+, \d{4} \(the clocks go forward\), so that run is skipped\.$/);
  const half = JSON.parse(ok(['routine', 'preview', 'cron 0,30 2 * * *', '--json'], undefined, { TZ: 'Europe/Amsterdam' }));
  assert.equal(half.tz, 'Europe/Amsterdam');
  assert.match(half.warnings[0], /^The clocks go forward on Mar \d+, \d{4}, so the runs from 02:00 to 02:30 are skipped\.$/);
  assert.deepEqual(JSON.parse(ok(['routine', 'preview', 'cron */30 * * * *', '--json'], undefined, { TZ: 'Europe/Amsterdam' })).warnings, [], 'every half hour: just a run fewer that night');
  assert.deepEqual(JSON.parse(ok(['routine', 'preview', 'daily 09:00', '--json'], undefined, { TZ: 'America/Chicago' })).warnings, [], 'a time every day has');
  assert.deepEqual(JSON.parse(ok(['routine', 'preview', 'daily 02:30', '--json'], undefined, { TZ: 'Asia/Tokyo' })).warnings, [], 'a zone without clock changes');
  assert.deepEqual(JSON.parse(ok(['capabilities', '--json'], undefined, { TZ: 'Europe/Amsterdam' })).clock, { tz: 'Europe/Amsterdam' });
  assert.ok(Array.isArray(scheduleWarnings(parseSchedule('daily 02:30').cron)));
});

test('--dry-run on add and edit runs every check and prints "Would set up:" without saving', (t) => {
  const { ok, run, store } = setup(t);
  ok(['create', 'general']);
  const out = ok(['routine', 'add', 'general', 'standup', '--schedule', 'weekdays 9:30', '--dry-run', 'Ask me for my plan.']);
  assert.match(out, /^Would set up:\n {2}Routine: {3}standup in #general\n {2}When: {6}Weekdays at 09:30, this Mac's time\n[^]*\(A dry run: nothing is saved\. Run the same command without --dry-run to set it up\.\)$/m);
  assert.deepEqual(store().channels[0].routines ?? [], [], 'nothing saved');
  // The checks still run: a bad schedule, a taken name or a missing routine fails the same way.
  assert.match(run(['routine', 'add', 'general', 'x', '--schedule', 'weekdays 25:00', '--dry-run', 'x']).stderr, /isn't a time/);
  ok(['routine', 'add', 'general', 'standup', '--schedule', 'weekdays 9:30', 'Ask me for my plan.']);
  assert.match(run(['routine', 'add', 'general', 'standup', '--schedule', 'daily 9:00', '--dry-run', 'x']).stderr, /already has a routine/);
  assert.match(run(['routine', 'edit', 'general', 'nope', '--schedule', 'daily 9:00', '--dry-run']).stderr, /has no routine "nope"/);
  const before = JSON.stringify(store());
  const edited = ok(['routine', 'edit', 'general', 'standup', '--schedule', 'weekly fri 16:00', '--dry-run']);
  assert.match(edited, /^Would set up:\n[^]*When: {6}Fridays at 16:00[^]*Next runs: Fri /m);
  assert.match(edited, /to make the change\.\)$/m);
  const json = JSON.parse(ok(['routine', 'edit', 'general', 'standup', '--off', '--dry-run', '--json']));
  assert.deepEqual([json.enabled, json.dry_run], [false, true]);
  assert.equal(JSON.stringify(store()), before, 'an edit dry run saves nothing either');
  assert.match(run(['routine', 'rm', 'general', 'standup', '--dry-run']).stderr, /--dry-run goes with add, edit, on and off/);
  assert.equal(store().channels[0].routines.length, 1);
  assert.ok(JSON.parse(ok(['capabilities', '--json'])).features.includes('routine-dry-run'));
});

test('a one-off reads as its date, and the block shows a prompt\'s first line only', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  const now = at(2026, 11, 22, 12);
  const r = R.addRoutine(c, { name: 'call-back', prompt: 'Remind me to call the bank.\nThen remove this routine.', spec: 'cron 0 15 24 11 *', catchupMin: 1440, now });
  const block = R.confirmation({ verb: 'add', channel: 'general', routine: r, now });
  assert.match(block, /When: {6}Nov 24 at 15:00, each year, this Mac's time/);
  assert.match(block, /Next runs: Tue Nov 24, 15:00 and Wed Nov 24 2027, 15:00/);
  assert.match(block, /Catch-up: {2}runs up to 1 day late/);
  assert.match(block, /Prompt: {4}"Remind me to call the bank\." \(\+1 more line\)/);
  const words = R.confirmation({ verb: 'on', channel: 'general', routine: r, now, where: 'server', cli: 'hub channels' });
  assert.match(words, /^Switched #general's routine call-back on:/);
  assert.match(words, /if server was asleep[^]*\(hub channels routine edit general call-back …\)/);
});

test('a fired run states the real weekday and time, and asks for the outcome first, quiet runs stopping there', async () => {
  const R = await import('../bin/routines.mjs');
  const text = R.routineText({ channel: 'general', routine: { name: 'x', prompt: 'P', schedule: 'weekdays 09:00' }, slot: at(2026, 11, 23, 9), now: at(2026, 11, 23, 9, 0) + 20_000 });
  assert.match(text, /\(Weekdays at 09:00\)/, 'the schedule in words');
  assert.match(text, /^For you \(it is Monday, Nov 23, 09:00 on this Mac's clock\):$/m);
  assert.match(text, /Open your reply with one plain line that says the outcome\. When there is nothing that needs the user, that line is the whole reply\./);
  assert.match(text, /limits when it applies[^]*check that against the day and time above/);
  assert.match(text, /Don't ask the user anything unless you can't go on without an answer/);
  assert.doesNotMatch(text, /If you need the user, ask/);
  const manual = R.routineText({ channel: 'general', routine: { name: 'x', prompt: 'P', schedule: 'manual' }, now: at(2026, 11, 28, 18, 5), manual: true, where: 'server' });
  assert.match(manual, /For you \(it is Saturday, Nov 28, 18:05 on server's clock\)/);
  assert.match(manual, /the user asked for this run now, so do it even if the prompt limits when it applies/, 'a run now is a try-out: the prompt\'s limits don\'t stop it');
  assert.doesNotMatch(manual, /say so in that one line and stop/);
});

test('the chat prompt teaches rounding, one-offs, --dry-run, passing the block on, and reading why a run didn\'t happen', async () => {
  const R = await import('../bin/routines.mjs');
  const p = R.promptText({ name: 'general', who: 'Sam', where: 'server', cli: 'hub channels' });
  for (const s of [
    'pick the nearest schedule that does, and say what you chose',
    'a day matching either one runs',
    'Then remove this routine: hub channels routine rm general <name>',
    '--catchup 1d',
    'headed "Would set up:"',
    'Pass it on to Sam as it is',
    'hub channels routine list general --json',
    'queued (', 'delivered (', 'missed (', 'dropped (', 'skipped (', 'enabled (false: switched off',
    'one plain line with the outcome first',
  ]) assert.ok(p.includes(s), s);
  assert.doesNotMatch(p, /this Mac|the user/);
});

// ---------- the run ledger's seams: run ids, entries as data, one status, why a run waits, who asked ----------

test('a run\'s id is its routine and slot, so a slot claimed twice is queued once and its last run is left alone', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'a', prompt: 'A.', spec: 'daily 09:00', now: at(2026, 11, 23, 8) });
  const r = c.routines[0];
  const slot = at(2026, 11, 23, 9);
  const e = R.queueRun(c, r, { kind: 'scheduled', slot, now: slot + 30_000 });
  assert.equal(e.id, `${r.id}@${new Date(slot).toISOString()}`);
  assert.equal(R.runId(r, { slot }), e.id);
  const before = { ...r.last };
  assert.equal(R.queueRun(c, r, { kind: 'scheduled', slot, now: slot + 90_000 }), e, 'the same entry');
  assert.deepEqual([c.queue.length, r.last], [1, before]);
  assert.match(R.runId(r, { now: at(2026, 11, 23, 12) }), new RegExp(`^${r.id}@manual-2026-11-2\\dT`));
});

test('a queue entry is data, and its message is made when it is typed in: late because the chat was busy, or the old text', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'a', prompt: 'Plan.', spec: 'daily 09:00', now: at(2026, 11, 23, 8) });
  R.claimDue({ channels: [c] }, at(2026, 11, 23, 9) + 20_000);
  const e = c.queue[0];
  assert.deepEqual(Object.keys(e).sort(), ['by', 'first', 'id', 'kind', 'label', 'name', 'prev', 'prompt', 'queued_at', 'routine', 'scheduled_for', 'text'].sort());
  assert.deepEqual([e.kind, e.prompt, e.label, e.first], ['scheduled', 'Plan.', 'Every day at 09:00', true]);
  assert.doesNotMatch(e.text, /late/, 'queued on time');
  // The chat was busy until 09:40: the message typed then says so.
  const text = R.renderRun(e, { channel: 'general', now: at(2026, 11, 23, 9, 40) });
  assert.match(text, /^\[routine a · scheduled 09:00, running 09:40 · run rt_\w+@[^\]]+\] #general\n/);
  assert.match(text, /because the chat couldn't take it until now\./);
  assert.match(text, /This is its first run\./);
  // An entry from before entries were data is typed as it was written.
  assert.equal(R.renderRun({ id: 'x', routine: 'r', name: 'a', text: '[routine a, run now] #general\nOld.' }, { channel: 'general' }), '[routine a, run now] #general\nOld.');
});

test('a run after a missed one says so, and the missed one records its catch-up and why (asleep, or off when the machine booted since)', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'a', prompt: 'A.', spec: 'daily 09:00', catchupMin: 60, now: at(2026, 11, 22, 8) });
  R.claimDue({ channels: [c] }, at(2026, 11, 23, 11, 40));
  const r = c.routines[0];
  assert.deepEqual([r.last.status, r.last.reason, r.last.catchup_min], ['missed', 'asleep', 60]);
  const st = R.routineStatus(r, at(2026, 11, 23, 12), { where: 'this Mac' });
  assert.deepEqual([st.state, st.words], ['missed', 'Skipped 09:00: this Mac was asleep until 11:40 (catch-up 1 hour)']);
  // Booted at 10:00, after the slot: it was off.
  const d = { name: 'd', routines: [], queue: [] };
  R.addRoutine(d, { name: 'b', prompt: 'B.', spec: 'daily 09:00', catchupMin: 15, now: at(2026, 11, 22, 8) });
  R.claimDue({ channels: [d] }, at(2026, 11, 23, 11, 40), { bootedAt: at(2026, 11, 23, 10) });
  assert.match(R.routineStatus(d.routines[0], at(2026, 11, 23, 12)).words, /was off until 11:40 \(catch-up 15 min\)$/);
  // The next day's run says the previous one was missed.
  R.claimDue({ channels: [c] }, at(2026, 11, 24, 9) + 20_000);
  assert.match(c.queue[0].text, /Its previous run was missed: it was due (Mon )?09:00, while this Mac was asleep\./);
  assert.doesNotMatch(c.queue[0].text, /first run/);
});

test('routineStatus: one state for each case, in words the command and the dialog both show', async () => {
  const R = await import('../bin/routines.mjs');
  const now = at(2026, 11, 23, 9, 14);
  const base = { id: 'rt_x', name: 'a', prompt: 'A.', schedule: 'daily 09:00', catchup_min: 60, enabled: true };
  const st = (r) => { const s = R.routineStatus({ ...base, ...r }, now); return [s.state, s.words]; };
  assert.deepEqual(st({}), ['never', 'Never run']);
  assert.deepEqual(st({ schedule: 'daily 25:00' })[0], 'broken');
  assert.deepEqual(st({ enabled: false }), ['off', 'Off']);
  assert.deepEqual(st({ enabled: false, paused: { by: 'you', at: new Date(at(2026, 11, 23, 8, 2)).toISOString() } }), ['off', 'Off since 08:02 · switched off by you']);
  assert.deepEqual(st({ enabled: false, paused: { by: 'chat', at: new Date(at(2026, 11, 21, 8)).toISOString() } }), ['off', 'Off since Sat · switched off by the chat']);
  const q = { kind: 'scheduled', status: 'queued', due_at: new Date(at(2026, 11, 23, 9)).toISOString(), at: new Date(at(2026, 11, 23, 9)).toISOString(), message: 'm' };
  assert.deepEqual(st({ last: q }), ['waiting', 'Waiting 14 min for the chat']);
  assert.deepEqual(st({ last: { ...q, waiting: { why: 'a draft is typed in the chat\'s prompt', since: q.at } } }), ['waiting', 'Waiting 14 min: a draft is typed in the chat\'s prompt']);
  assert.deepEqual(st({ last: { ...q, kind: 'manual', due_at: null, at: new Date(now - 20_000).toISOString() } }), ['waiting', 'Queued for the chat… · run now']);
  const d = { ...q, status: 'delivered', delivered_at: new Date(at(2026, 11, 23, 9, 1)).toISOString() };
  assert.deepEqual(st({ last: d }), ['ok', 'Delivered 09:01']);
  assert.deepEqual(st({ last: { ...d, delivered_at: new Date(at(2026, 11, 23, 9, 12)).toISOString() } }), ['late', 'Delivered 09:12 · due 09:00, 12 min late']);
  assert.deepEqual(st({ last: { ...q, status: 'missed', reason: null } }), ['missed', 'Skipped 09:00 (catch-up 1 hour)']);
});

test('why a run waits is kept on its last run until the chat has it', async () => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'a', prompt: 'A.', spec: 'daily 09:00', now: at(2026, 11, 23, 8) });
  const e = R.runNow(c, 'a', { now: at(2026, 11, 23, 9), by: 'dialog' });
  assert.equal(R.markWaiting(c, e.id, 'its claude is busy', at(2026, 11, 23, 9, 1)), true);
  assert.equal(R.markWaiting(c, e.id, 'its claude is busy', at(2026, 11, 23, 9, 2)), false, 'the same reason again changes nothing');
  R.markWaiting(c, e.id, 'a draft is typed in the chat\'s prompt', at(2026, 11, 23, 9, 3));
  const r = c.routines[0];
  assert.deepEqual(r.last.waiting, { why: 'a draft is typed in the chat\'s prompt', since: new Date(at(2026, 11, 23, 9, 1)).toISOString() });
  R.markDelivered(c, e.id, at(2026, 11, 23, 9, 5));
  assert.deepEqual([r.last.status, r.last.waiting, r.last.by], ['delivered', undefined, 'dialog']);
  assert.equal(R.markWaiting(c, 'gone', 'x'), false);
});

test('--by says who asked: a run now\'s message names it, and off records who switched it off until it is on again', async (t) => {
  const R = await import('../bin/routines.mjs');
  const c = { name: 'general', routines: [], queue: [] };
  R.addRoutine(c, { name: 'a', prompt: 'A.', spec: 'daily 09:00', now: at(2026, 11, 23, 8) });
  assert.match(R.runNow(c, 'a', { now: at(2026, 11, 23, 9), by: 'dialog', who: 'Sam' }).text, /Sam asked, in the Routines dialog, for this routine of #general to run now\./);
  assert.match(R.runNow(c, 'a', { now: at(2026, 11, 23, 9, 1), by: 'chat' }).text, /This chat asked for this routine of #general to run now\./);
  R.editRoutine(c, 'a', { enabled: false, by: 'you' }, at(2026, 11, 23, 10));
  assert.deepEqual(c.routines[0].paused, { by: 'you', at: new Date(at(2026, 11, 23, 10)).toISOString() });
  R.editRoutine(c, 'a', { enabled: true }, at(2026, 11, 23, 11));
  assert.equal(c.routines[0].paused, null);
  assert.throws(() => R.byName('two words'), /--by is who asked/);
  // Through the command: stored, shown in list --json, and in the list's words.
  const { ok, store } = setup(t);
  ok(['create', 'general']);
  ok(['routine', 'add', 'general', 'morning-plan', '--schedule', 'daily 09:00', 'Plan.']);
  ok(['routine', 'run', 'general', 'morning-plan', '--by', 'cli']);
  assert.deepEqual([store().channels[0].queue[0].by, store().channels[0].routines[0].last.by], ['cli', 'cli']);
  ok(['routine', 'off', 'general', 'morning-plan', '--by', 'you']);
  const shown = JSON.parse(ok(['list', '--json'])).channels[0].routines[0];
  assert.equal(shown.paused.by, 'you');
  assert.deepEqual([shown.status.state, shown.status.words.replace(/since \S+/, 'since X')], ['off', 'Off since X · switched off by you']);
  assert.match(ok(['routine', 'list']), /morning-plan {2}off .*Off since \S+ · switched off by you/);
  assert.ok(JSON.parse(ok(['capabilities', '--json'])).features.includes('routine-by'));
});

test('each tick writes its heartbeat, which list --json shows as the timer\'s last tick', async (t) => {
  const { ok, dir, tickAt } = setup(t);
  ok(['create', 'general']);
  assert.equal(JSON.parse(ok(['list', '--json'])).timer.last_tick_at, null);
  await tickAt(Date.now());
  const beat = JSON.parse(readFileSync(join(dir, 'tick.json'), 'utf8'));
  assert.deepEqual(Object.keys(beat).sort(), ['at', 'claimed', 'errors', 'sent', 'version']);
  const timer = JSON.parse(ok(['list', '--json'])).timer;
  assert.deepEqual([timer.last_tick_at, timer.stale], [beat.at, false]);
  assert.match(timer.hint, /^launchctl kickstart -k gui\/\$\(id -u\)\/dev\.herdr-channels\.tick$/);
  assert.equal(JSON.parse(ok(['routine', 'list', '--json'])).timer.last_tick_at, beat.at);
  const R = await import('../bin/routines.mjs');
  assert.equal(R.timerStatus(beat, Date.parse(beat.at) + 6 * MIN).stale, true);
});
