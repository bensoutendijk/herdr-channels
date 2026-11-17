// channels end to end: the store's commands, start, file, read, send, dismiss, the chat and its listener, against a
// fake home folder, a fake `claude` that records how it was started and a fake `hc` that records what it was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/channels.mjs', import.meta.url));
const HERE = 'testmac';
const OLD = 'aaaaaaaa-1111-4111-8111-111111111111'; // a finished background session in the app project
const APP = 'bbbbbbbb-2222-4222-8222-222222222222'; // an interactive session, running
const GONE = 'cccccccc-3333-4333-8333-333333333333'; // known only from its transcript

const FAKE_CLAUDE = (home) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = ${JSON.stringify(home)};
const args = process.argv.slice(2);
const at = (f) => path.join(home, f);
fs.appendFileSync(at('claude-calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null, keep: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\\n');
const n = fs.readFileSync(at('claude-calls.jsonl'), 'utf8').split('\\n').filter(Boolean).length;
if (args[0] === 'agents') { process.stdout.write(fs.existsSync(at('agents.json')) ? fs.readFileSync(at('agents.json'), 'utf8') : '[]'); process.exit(0); }
// The job's process, from its record in ~/.claude/sessions, and whether it still runs.
const sessions = path.join(home, '.claude', 'sessions');
const records = () => (fs.existsSync(sessions) ? fs.readdirSync(sessions).map((f) => JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8'))) : []);
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// As Claude Code's does, stop returns at once and the process exits a moment later (unless the test says it hangs).
if (args[0] === 'stop') {
  const rec = records().find((r) => r.jobId === args[1]);
  if (rec && !fs.existsSync(at('stop-hangs'))) require('child_process').spawn('sh', ['-c', 'sleep 0.6; kill ' + rec.pid], { detached: true, stdio: 'ignore' }).unref();
  process.stdout.write('stopped ' + args[1] + '\\n'); process.exit(0);
}
// As Claude Code's does, resuming a session whose process still runs starts a copy: a new job and session.
if (args[0] === '--bg' && args[1] === '--resume') {
  const jobs = path.join(home, '.claude', 'jobs');
  const job = fs.readdirSync(jobs).find((j) => JSON.parse(fs.readFileSync(path.join(jobs, j, 'state.json'), 'utf8')).sessionId === args[2]);
  if (fs.existsSync(at('resume-copies')) || records().some((r) => r.sessionId === args[2] && running(r.pid))) {
    const copy = 'eeee' + String(n).padStart(4, '0');
    const dir = path.join(jobs, copy); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionId: copy + '-0000-4000-8000-000000000000', state: 'working', name: args[3].slice(0, 30), nameSource: 'auto', cwd: process.cwd() }));
    process.stdout.write('backgrounded · ' + copy + ' · x\\n'); process.exit(0);
  }
  process.stdout.write('backgrounded · ' + job + ' · x\\n'); process.exit(0);
}
if (args[0] === '--bg') {
  const job = 'dddd' + String(n).padStart(4, '0');
  const dir = path.join(home, '.claude', 'jobs', job); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionId: job + '-0000-4000-8000-000000000000', state: 'working', name: args[args.indexOf('-n') + 1], cwd: process.cwd() }));
  process.stdout.write('backgrounded · ' + job + ' · x\\n  claude attach ' + job + '    open in this terminal\\n'); process.exit(0);
}
if (args[0] === '--session-id' || args[0] === '--resume') {
  fs.appendFileSync(at('chat-launches.jsonl'), JSON.stringify({ args, cwd: process.cwd(), path: process.env.PATH, dir: process.env.CHANNELS_DIR, projects: process.env.CHANNELS_PROJECTS, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
  // Stay up, as a chat does, until the listener has sent what the test waits for.
  const want = Number(process.env.FAKE_WAIT_SENDS || 0);
  const until = Date.now() + 15000;
  const sends = () => (fs.existsSync(at('hc-sends.jsonl')) ? fs.readFileSync(at('hc-sends.jsonl'), 'utf8').split('\\n').filter(Boolean).length : 0);
  const t = setInterval(() => { if (sends() >= want || Date.now() > until) { clearInterval(t); process.exit(0); } }, 50);
} else process.exit(1);
`;

const FAKE_HC = (home) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = ${JSON.stringify(home)};
const args = process.argv.slice(2);
if (args[0] === 'get') { process.stdout.write(JSON.stringify({ address: args[1], status: 'idle' })); process.exit(0); }
if (args[0] === 'send') {
  if (fs.existsSync(path.join(home, 'hc-fail'))) { process.stderr.write('the program is blocked\\n'); process.exit(3); }
  fs.appendFileSync(path.join(home, 'hc-sends.jsonl'), JSON.stringify({ terminal: args[1], text: args[2] }) + '\\n'); process.exit(0);
}
process.exit(2);
`;

function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'channels-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const projects = join(home, 'projects');
  for (const p of ['app', 'site']) mkdirSync(join(projects, p), { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'claude'), FAKE_CLAUDE(home));
  writeFileSync(join(home, 'bin', 'hc'), FAKE_HC(home));
  chmodSync(join(home, 'bin', 'claude'), 0o755);
  chmodSync(join(home, 'bin', 'hc'), 0o755);
  const dir = join(home, 'store');
  const env = (extra = {}) => ({
    ...process.env, HOME: home, CHANNELS_DIR: dir, CHANNELS_PROJECTS: projects, CHANNELS_MACHINE: HERE,
    CHANNELS_CLAUDE: join(home, 'bin', 'claude'), CHANNELS_HC: join(home, 'bin', 'hc'), HC_TERMINAL_ID: '',
    // As if run from inside a Claude Code session: these must not reach a task.
    CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CONFIG_DIR: join(home, '.claude'), ...extra,
  });
  const run = (args, input, extra) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, env: env(extra), timeout: 30000 });
  const ok = (args, input, extra) => { const r = run(args, input, extra); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout; };
  const list = (...extra) => JSON.parse(ok(['list', '--json', ...extra]));
  const lines = (f) => (existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // Claude Code's records, as the tests need them.
  const job = (id, state, timeline = 1) => {
    mkdirSync(join(home, '.claude', 'jobs', id), { recursive: true });
    writeFileSync(join(home, '.claude', 'jobs', id, 'state.json'), JSON.stringify(state));
    writeFileSync(join(home, '.claude', 'jobs', id, 'timeline.jsonl'), Array.from({ length: timeline }, (_, i) => JSON.stringify({ i })).join('\n'));
  };
  const transcript = (id, entries) => {
    mkdirSync(join(home, '.claude', 'projects', '-x'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-x', `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n'));
  };
  // A running process's own record. A process started for it stands in for the session: a `sleep` left to the
  // system (not this test's child, which would linger as a zombie once killed), stopped after the test.
  const sleepers = [];
  t.after(() => { for (const pid of sleepers) { try { process.kill(pid); } catch { /* gone */ } } });
  const live = (sessionId, extra) => {
    const pid = Number(spawnSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim());
    sleepers.push(pid);
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'sessions', 'live.json'), JSON.stringify({ pid, sessionId, status: 'idle', ...extra }));
    return pid;
  };
  const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const store = () => JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8'));
  job('aaaaaaaa', { sessionId: OLD, state: 'done', name: 'Fix the total', cwd: join(projects, 'app') });
  transcript(GONE, [{ type: 'user', cwd: join(projects, 'site'), message: { content: 'hi' } }, { type: 'custom-title', customTitle: 'Old talk' }]);
  writeFileSync(join(home, 'agents.json'), JSON.stringify([
    { id: 'aaaaaaaa', kind: 'background', sessionId: OLD, state: 'done', cwd: join(projects, 'app') },
    { kind: 'interactive', pid: 7, sessionId: APP, name: 'Docs pass', cwd: join(projects, 'site') },
  ]));
  return { home, dir, projects, run, ok, list, lines, job, transcript, live, running, store, env };
}

test('an empty store lists no channels, and list --json says which machine answers', (t) => {
  const { ok, list } = setup(t);
  assert.deepEqual(list(), { machine: HERE, channels: [] });
  assert.match(ok([]), /No channels yet/);
});

test('create makes a channel and its description file; describe shows and sets it', (t) => {
  const { ok, run, list, dir } = setup(t);
  assert.match(ok(['create', '#Design', '--icon', '🎨']), /Created #design/);
  const [c] = list().channels;
  assert.match(c.id, /^ch_[0-9a-f]{12}$/);
  assert.deepEqual({ ...c, id: 'x', created_at: typeof c.created_at }, { id: 'x', name: 'design', position: 1, icon: '🎨', created_at: 'string', archived_at: null, description_path: join(dir, 'design.md'), chat: null, tasks: [] });
  assert.equal(readFileSync(join(dir, 'design.md'), 'utf8'), '');
  ok(['describe', 'design', '--set', '# design\nThe look.']);
  assert.equal(ok(['describe', 'design']), '# design\nThe look.\n');
  ok(['describe', 'design', '--set', '-'], 'From stdin\n\n');
  assert.equal(readFileSync(join(dir, 'design.md'), 'utf8'), 'From stdin\n');
  assert.match(run(['create', 'design']).stderr, /#design already exists/);
  assert.match(run(['create', 'Bad name!']).stderr, /A channel name is lowercase/);
  assert.match(run(['describe', 'nope']).stderr, /No channel #nope/);
});

test('move, rename, icon and archive keep the order, the id, the tasks and the description', (t) => {
  const { ok, run, list, dir } = setup(t);
  for (const n of ['one', 'two', 'three']) ok(['create', n]);
  ok(['move', 'three', '1']);
  assert.deepEqual(list().channels.map((c) => [c.name, c.position]), [['three', 1], ['one', 2], ['two', 3]]);
  ok(['move', 'three', '99']);
  assert.deepEqual(list().channels.map((c) => c.name), ['one', 'two', 'three']);
  const id = list().channels[0].id;
  ok(['describe', 'one', '--set', 'First']);
  assert.match(ok(['rename', 'one', 'first']), /Renamed #one to #first/);
  const [c] = list().channels;
  assert.deepEqual([c.name, c.id, readFileSync(join(dir, 'first.md'), 'utf8')], ['first', id, 'First\n']);
  assert.equal(existsSync(join(dir, 'one.md')), false);
  assert.match(run(['rename', 'first', 'two']).stderr, /#two already exists/);
  ok(['icon', 'first', '🧭']);
  assert.equal(list().channels[0].icon, '🧭');
  ok(['icon', 'first', '']);
  assert.equal(list().channels[0].icon, null);
  assert.match(ok(['archive', 'two']), /Archived #two/);
  assert.deepEqual(list().channels.map((c) => [c.name, c.position]), [['first', 1], ['three', 2]]);
  assert.deepEqual(list('--all').channels.map((c) => [c.name, c.position]), [['first', 1], ['two', null], ['three', 2]]);
  assert.match(run(['move', 'two', '1']).stderr, /#two is archived/);
});

test('start runs `claude --bg` in the projects folder or a project, without the calling session\'s variables, and records the task', (t) => {
  const { home, projects, ok, run, list, lines } = setup(t);
  ok(['create', 'design', '--description', 'The look.']);
  const out = ok(['start', 'design', '--repo', 'app', 'Make', 'the', 'header', 'sticky']);
  assert.match(out, new RegExp(`^Started ${HERE}/dddd0001-0000-4000-8000-000000000000 in #design \\(app\\): Make the header sticky`));
  const [call] = lines('claude-calls.jsonl');
  assert.equal(call.cwd, join(projects, 'app'));
  assert.deepEqual(call.args, ['--bg', '-n', 'Make the header sticky', '--permission-mode', 'auto', 'Make the header sticky']);
  assert.deepEqual([call.claudecode, call.child, call.keep], [null, null, join(home, '.claude')], 'the session variables go; settings stay');
  ok(['start', 'design', '--name', 'Talk it over', '--permission-mode', 'default', '-'], 'Should the header shrink?');
  const second = lines('claude-calls.jsonl')[1];
  assert.equal(second.cwd, projects);
  assert.deepEqual(second.args, ['--bg', '-n', 'Talk it over', '--permission-mode', 'default', 'Should the header shrink?']);
  const tasks = list().channels[0].tasks;
  assert.deepEqual(tasks.map((x) => [x.id, x.name, x.repo, x.folder, x.how, x.job, x.dismissed]), [
    [`${HERE}/dddd0002-0000-4000-8000-000000000000`, 'Talk it over', null, projects, 'started', 'dddd0002', false],
    [`${HERE}/dddd0001-0000-4000-8000-000000000000`, 'Make the header sticky', 'app', join(projects, 'app'), 'started', 'dddd0001', false],
  ], 'newest first');
  assert.match(run(['start', 'design', '--repo', 'nope', 'x']).stderr, /--repo is a folder in .*: app, site/);
  assert.match(run(['start', 'design', '--repo', '..', 'x']).stderr, /--repo is a folder/);
  assert.match(run(['start', 'ghost', 'x']).stderr, /No channel #ghost/);
  assert.match(run(['start', 'design', '--machine', 'other', 'x']).stderr, /Unknown option --machine/);
  assert.equal(lines('claude-calls.jsonl').length, 2, 'a refused start runs nothing');
});

test('file takes a session by id, the start of one, a job or a transcript; another machine is refused', (t) => {
  const { ok, run, list } = setup(t);
  ok(['create', 'general']);
  assert.match(ok(['file', 'general', 'aaaaaaaa-11']), new RegExp(`Filed ${HERE}/${OLD} into #general: Fix the total`));
  ok(['file', 'general', APP]);
  ok(['file', 'general', GONE]);
  const tasks = Object.fromEntries(list().channels[0].tasks.map((x) => [x.session_id, x]));
  assert.deepEqual([tasks[OLD].repo, tasks[OLD].job, tasks[OLD].how], ['app', 'aaaaaaaa', 'filed']);
  assert.deepEqual([tasks[APP].name, tasks[APP].repo, tasks[APP].job], ['Docs pass', 'site', null]);
  assert.deepEqual([tasks[GONE].name, tasks[GONE].repo], ['Old talk', 'site']);
  assert.match(run(['file', 'general', 'eeeeeeee-0000-4000-8000-000000000000']).stderr, /No session eeeeeeee-0000-4000-8000-000000000000 on testmac/);
  assert.match(run(['file', 'general', `${HERE}/${OLD}`]).stderr, /already a task in #general/);
  assert.match(run(['file', 'general', 'server/2ebb0d50']).stderr, /this machine's only: "server" isn't testmac/);
  ok(['create', 'other']);
  assert.match(run(['file', 'other', OLD]).stderr, /is a task in #general; dismiss it there first/);
});

test('dismiss hides a task and records who, never touching the session; a dismissed task can be filed again elsewhere', (t) => {
  const { ok, run, list, lines } = setup(t);
  ok(['create', 'general']);
  ok(['create', 'other']);
  ok(['file', 'general', 'aaaaaaaa']);
  const calls = lines('claude-calls.jsonl').length;
  assert.match(ok(['dismiss', 'aaaaaaaa', '--by', 'sam']), /Dismissed .* from #general. The session itself is untouched/);
  assert.equal(lines('claude-calls.jsonl').length, calls, 'nothing was run');
  const [x] = list().channels[0].tasks;
  assert.deepEqual([x.dismissed, x.dismissed_by], [true, 'sam']);
  assert.match(ok(['dismiss', OLD]), /already dismissed/);
  assert.match(ok(['list']), /no tasks \(1 dismissed\)/);
  assert.match(run(['dismiss', OLD, '--by', 'Not Valid']).stderr, /--by is one short lowercase word/);
  ok(['file', 'other', OLD]);
  assert.deepEqual(list().channels.map((c) => c.tasks.length), [0, 1], 'it moved');
});

test('read shows a session\'s state and its messages, the last one whole', (t) => {
  const { ok, transcript, job } = setup(t);
  const long = `Done. ${'All the details. '.repeat(400)}The end.`;
  job('aaaaaaaa', { sessionId: OLD, state: 'done', detail: 'fixed the total', name: 'Fix the total', cwd: '/x', output: { result: 'Fixed' } });
  transcript(OLD, [
    { type: 'user', timestamp: '2026-01-02T03:04:00Z', message: { content: 'Fix the total' } },
    { type: 'assistant', timestamp: '2026-01-02T03:05:00Z', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read' }] } },
    { type: 'assistant', timestamp: '2026-01-02T03:06:00Z', message: { content: [{ type: 'tool_use', name: 'Edit' }] } },
    { type: 'assistant', timestamp: '2026-01-02T03:07:00Z', message: { content: [{ type: 'text', text: long }] } },
  ]);
  const out = ok(['read', 'aaaaaaaa']);
  assert.match(out, /^Fix the total  testmac\/aaaaaaaa-1111/);
  assert.match(out, /done: fixed the total/);
  assert.match(out, /\(2 tool calls\)/);
  assert.ok(out.includes(long), 'the last message is whole');
  const r = JSON.parse(ok(['read', OLD, '--json', '--limit', '2']));
  assert.equal(r.summary.last_agent_message, long);
  assert.deepEqual(r.messages.map((m) => m.who), ['agent', 'tools'], 'newest first');
  assert.equal(r.more, true);
});

test('send wakes a background session whose turn is over, and refuses one that is working, prompting, or not in the background', (t) => {
  const { ok, run, lines, live, running, job } = setup(t);
  ok(['create', 'general']);
  ok(['file', 'general', 'aaaaaaaa']);
  const pid = live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  // The fake stop, like Claude Code's, returns before the process exits, and resuming before it exits starts a
  // copy: send continues the session itself only because it waits for the process to exit first.
  assert.match(ok(['send', 'aaaaaaaa', 'Also', 'check', 'the', 'tax']), /Sent to testmac\/aaaaaaaa-1111.*It continues/);
  assert.equal(running(pid), false);
  const calls = lines('claude-calls.jsonl').slice(-2);
  assert.deepEqual(calls[0].args, ['stop', 'aaaaaaaa']);
  assert.deepEqual(calls[1].args, ['--bg', '--resume', OLD, "From the user via #general's chat: Also check the tax"]);
  assert.equal(calls[1].claudecode, null);
  live(OLD, { status: 'busy' });
  job('aaaaaaaa', { sessionId: OLD, state: 'working', name: 'Fix the total' });
  assert.match(run(['send', OLD, 'x']).stderr, /is working/);
  live(OLD, { status: 'waiting', waitingFor: 'permission for Bash' });
  assert.match(run(['send', OLD, 'x']).stderr, /showing a prompt \(permission for Bash\)/);
  assert.match(run(['send', GONE, 'x']).stderr, /isn't a background session/);
});

test('send to a task whose process doesn\'t exit after stop fails plainly and starts nothing', (t) => {
  const { home, ok, run, lines, live, running, list } = setup(t);
  ok(['create', 'general']);
  ok(['file', 'general', 'aaaaaaaa']);
  const pid = live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  writeFileSync(join(home, 'stop-hangs'), '');
  const r = run(['send', OLD, 'Blue.'], '', { CHANNELS_STOP_WAIT_MS: '700' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`was told to stop, but its process \\(pid ${pid}\\) still runs after 0.7s. The message wasn't sent and nothing was started`));
  assert.deepEqual(lines('claude-calls.jsonl').map((c) => c.args[0]).slice(-1), ['stop'], 'no --bg --resume');
  assert.ok(running(pid));
  assert.equal(list().channels[0].tasks.length, 1);
});

test('send files a copy Claude Code starts in place of the task, and marks the original superseded by it', (t) => {
  const { home, ok, run, list, live, job, store } = setup(t);
  ok(['create', 'general']);
  ok(['file', 'general', 'aaaaaaaa', '--name', 'Pick the colour']);
  live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  writeFileSync(join(home, 'resume-copies'), '');
  const out = ok(['send', OLD, 'Blue.']);
  const [, copyJob] = /\(job (eeee\d{4})\)/.exec(out) ?? [];
  const copy = `${copyJob}-0000-4000-8000-000000000000`;
  assert.match(out, new RegExp(`didn't continue ${HERE}/${OLD}: it started a copy of it, ${HERE}/${copy} \\(job ${copyJob}\\), and the message went to the copy`));
  assert.match(out, /filed into #general as "Pick the colour" in its place, and the original task is marked superseded/);
  const tasks = Object.fromEntries(list('--all').channels[0].tasks.map((x) => [x.session_id, x]));
  assert.deepEqual([tasks[copy].how, tasks[copy].name, tasks[copy].repo, tasks[copy].job, tasks[copy].dismissed], ['copied', 'Pick the colour', 'app', copyJob, false]);
  assert.deepEqual([tasks[OLD].dismissed, tasks[OLD].dismissed_by, tasks[OLD].superseded_by], [true, 'send', `${HERE}/${copy}`]);
  assert.equal(store().channels[0].tasks.find((x) => x.session_id === copy).copy_of, `${HERE}/${OLD}`);
  assert.deepEqual(list().channels[0].tasks.filter((x) => !x.dismissed).map((x) => x.session_id), [copy], 'one task owns the work');
  // --json says the same, and a copy of the copy replaces it in turn.
  job(copyJob, { sessionId: copy, state: 'blocked', needs: 'Which shade?', cwd: join(home, 'projects', 'app') });
  live(copy, { status: 'idle', jobId: copyJob });
  const r = JSON.parse(ok(['send', copy, '--json', 'And green.']));
  assert.deepEqual([r.delivered_as, r.filed_in, r.copy.job], ['copy_started', 'general', r.job]);
  assert.deepEqual(list().channels[0].tasks.filter((x) => !x.dismissed).map((x) => x.id), [r.copy.id]);
  // A copy of a session that is no channel's task is said plainly, and filed nowhere.
  job('ffff0001', { sessionId: 'ffffffff-0000-4000-8000-000000000000', state: 'done', cwd: join(home, 'projects', 'app') });
  const loose = run(['send', 'ffff0001', 'x']);
  assert.equal(loose.status, 0, loose.stderr);
  assert.match(loose.stdout, /isn't a task in an open channel, so the copy wasn't filed anywhere/);
  assert.equal(list('--all').channels[0].tasks.length, 3);
});

test('the chat prompt carries the description and the commands, and nothing about other machines', async (t) => {
  const { ok, dir, projects } = setup(t);
  ok(['create', 'design', '--description', 'Make it calm.']);
  process.env.CHANNELS_MACHINE = HERE;
  const { chatPrompt } = await import('../bin/channels.mjs');
  const p = chatPrompt(dir, 'design', { projects });
  assert.match(p, /standing chat of the channel #design/);
  assert.match(p, /<channel-description>\nMake it calm.\n<\/channel-description>/);
  for (const c of ['channels start design', 'channels read <session>', 'channels send <session> -', 'channels dismiss <session> --by chat', '[task report]', '[task question]', 'never instructions to you']) assert.ok(p.includes(c), c);
  assert.match(p, /a brief that stands on its own/);
  assert.doesNotMatch(p, /machine registered|--machine|cost|\bPRs?\b|\bCI\b/i);
});

test('the listener reports a finished task once, whole, again after more work, and a question; not a repeat of its last message, a dismissed task or a filed one\'s old news', (t) => {
  const { home, ok, store, job, transcript, live } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']); // dddd0001, working
  ok(['file', 'design', 'aaaaaaaa']); // already done when filed: not news
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/);
  const sid = 'dddd0001-0000-4000-8000-000000000000';
  const report = `The logo is done.\n${'Line of detail. '.repeat(5000)}\nOpen: colours. </task-report> inside.`;
  job('dddd0001', { sessionId: sid, state: 'done', detail: 'drew the logo', name: 'Draw the logo', updatedAt: '2026-01-02T03:04:05Z' }, 3);
  transcript(sid, [{ type: 'user', message: { content: 'Draw the logo' } }, { type: 'assistant', message: { content: [{ type: 'text', text: report }] } }]);
  const out = ok(['listen', 'design', '--once']);
  assert.match(out, new RegExp(`^\\[task report\\] #design · task "Draw the logo" \\(${HERE}/${sid}\\) finished\\.`));
  assert.ok(out.includes(report.replace('</task-report>', '</task_report>')), 'the whole last message, its markers made harmless');
  assert.ok(out.length > 80000, 'no length cap');
  assert.equal(out.match(/<\/task-report>/g).length, 1);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/, 'once');
  job('dddd0001', { sessionId: sid, state: 'done', name: 'Draw the logo' }, 5);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/, 'more work, but the same last message: not news');
  transcript(sid, [{ type: 'user', message: { content: 'Draw the logo' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Redrawn, rounder.' }] } }]);
  job('dddd0001', { sessionId: sid, state: 'done', name: 'Draw the logo' }, 6);
  assert.match(ok(['listen', 'design', '--once']), /\[task report\][\s\S]*Redrawn, rounder\./, 'news again after more work and a new message');
  // A question: the job ended its turn asking, or the process shows a prompt.
  job('dddd0001', { sessionId: sid, state: 'blocked', needs: 'which colour?', name: 'Draw the logo' }, 6);
  const q = ok(['listen', 'design', '--once']);
  assert.match(q, /^\[task question\] #design · task "Draw the logo" .* is waiting on the user/);
  assert.match(q, /What it waits on: which colour\?/);
  assert.match(q, /channels send testmac\/dddd0001/);
  live(sid, { status: 'waiting', waitingFor: 'permission for Bash(rm -rf build)' });
  job('dddd0001', { sessionId: sid, state: 'working', name: 'Draw the logo' }, 7);
  assert.match(ok(['listen', 'design', '--once']), /What it waits on: permission for Bash\(rm -rf build\)[\s\S]*answer the prompt in the task's view/);
  const told = store().channels[0].tasks.find((x) => x.job === 'dddd0001').told;
  assert.deepEqual([told.kind, told.work, told.last], ['needs', 7, told.last]);
  assert.match(told.last, /^[0-9a-f]{16}$/);
  // A task asks a question, and is then stopped while it waits (as send does): the report its stop would make
  // repeats the question the chat already has, so it isn't sent.
  rmSync(join(home, '.claude', 'sessions'), { recursive: true, force: true });
  transcript(sid, [{ type: 'user', message: { content: 'Draw the logo' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Which colour should it be?' }] } }]);
  job('dddd0001', { sessionId: sid, state: 'blocked', needs: 'Which colour should it be?', name: 'Draw the logo' }, 8);
  assert.match(ok(['listen', 'design', '--once']), /\[task question\][\s\S]*Which colour should it be\?/);
  job('dddd0001', { sessionId: sid, state: 'stopped', name: 'Draw the logo' }, 9);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/, 'a stop that repeats the question');
  assert.equal(store().channels[0].tasks.find((x) => x.job === 'dddd0001').told.kind, 'done', 'seen, so it is not looked at again');
  // Dismissed: not reported.
  ok(['dismiss', sid]);
  job('dddd0001', { sessionId: sid, state: 'done', name: 'Draw the logo' }, 12);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/);
});

test('chat records its session, launches claude with the prompt, and its listener pastes a finished task\'s report into its own terminal', (t) => {
  const { home, ok, run, list, lines, job, transcript, projects, dir } = setup(t);
  ok(['create', 'design', '--description', 'Calm.']);
  ok(['start', 'design', 'Draw the logo']);
  const sid = 'dddd0001-0000-4000-8000-000000000000';
  job('dddd0001', { sessionId: sid, state: 'done', name: 'Draw the logo' }, 2);
  transcript(sid, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Logo drawn. Open: colours.' }] } }]);
  const bin = join(home, 'cmd');
  const r = run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '1', CHANNELS_BIN: join(bin, 'channels') });
  assert.equal(r.status, 0, r.stderr);
  const chat = list().channels[0].chat;
  assert.equal(chat.machine, HERE);
  const [launch] = lines('chat-launches.jsonl');
  assert.deepEqual(launch.args.slice(0, 4), ['--session-id', chat.session_id, '-n', '#design']);
  assert.equal(launch.args[4], '--append-system-prompt');
  assert.match(launch.args[5], /<channel-description>\nCalm.\n/);
  assert.deepEqual([launch.cwd, launch.dir, launch.projects, launch.claudecode], [projects, dir, projects, null]);
  assert.ok(launch.path.startsWith(`${bin}:`), 'the chat finds `channels` first on PATH');
  const [sent] = lines('hc-sends.jsonl');
  assert.equal(sent.terminal, 't42');
  assert.match(sent.text, /^\[task report\] #design · task "Draw the logo"[\s\S]*<task-report>\nLogo drawn. Open: colours.\n<\/task-report>/);
  // The next launch resumes the same session once it has a transcript, and has nothing new to say.
  transcript(chat.session_id, [{ type: 'user', message: { content: 'hello' } }]);
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '1' }).status, 0);
  assert.deepEqual(lines('chat-launches.jsonl')[1].args.slice(0, 2), ['--resume', chat.session_id]);
  assert.equal(lines('hc-sends.jsonl').length, 1);
  assert.ok(existsSync(join(dir, 'listen.log')));
  assert.equal(existsSync(join(dir, `listen-${list().channels[0].id}.pid`)), false, 'the listener cleans up');
});

test('a report the chat can\'t take now is kept and arrives on a later look', (t) => {
  const { home, ok, run, lines, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  const sid = 'dddd0001-0000-4000-8000-000000000000';
  job('dddd0001', { sessionId: sid, state: 'done', name: 'Draw the logo' }, 2);
  transcript(sid, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Logo drawn.' }] } }]);
  writeFileSync(join(home, 'hc-fail'), '');
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '0' }).status, 0);
  assert.equal(lines('hc-sends.jsonl').length, 0);
  rmSync(join(home, 'hc-fail'));
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '1' }).status, 0);
  assert.match(lines('hc-sends.jsonl')[0].text, /Logo drawn\./);
});
