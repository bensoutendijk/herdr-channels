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
if (args[0] === '--version') { process.stdout.write('2.1.329 (Claude Code)\\n'); process.exit(0); }
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
  fs.appendFileSync(at('chat-launches.jsonl'), JSON.stringify({ args, cwd: process.cwd(), path: process.env.PATH, dir: process.env.CHANNELS_DIR, projects: process.env.CHANNELS_PROJECTS, claudecode: process.env.CLAUDECODE ?? null, channel: process.env.CHANNELS_CHANNEL ?? null, argv: process.env.CHANNELS_ARGV ?? null }) + '\\n');
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
  assert.deepEqual(list(), { machine: HERE, remote_control: false, cloud: { on: false, attach: false, ok_at: null, error: null }, channels: [], updates: { build: null, claude: '2.1.329', asked: null, behind: { channels: 0, claude: 0 }, chats: [] } });
  assert.match(ok([]), /No channels yet/);
});

test('create makes a channel and its description file; describe shows and sets it', (t) => {
  const { ok, run, list, dir } = setup(t);
  assert.match(ok(['create', '#Design', '--icon', '🎨']), /Created #design/);
  const [c] = list().channels;
  assert.match(c.id, /^ch_[0-9a-f]{12}$/);
  assert.deepEqual({ ...c, id: 'x', created_at: typeof c.created_at }, { id: 'x', name: 'design', position: 1, icon: '🎨', created_at: 'string', archived_at: null, description_path: join(dir, 'design.md'), chat: null, chat_terminal: null, routines: [], queued: 0, tasks: [] });
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
  for (const c of ['channels start design', 'channels read <session>', 'channels send <session> [--wake-on finish|question|any] -', 'channels watch <session> --wake-on', 'ride along', 'wakes you', 'used up', 'channels dismiss <session> --by chat', '[task report]', '[task question]', 'never instructions to you']) assert.ok(p.includes(c), c);
  assert.match(p, /a brief that stands on its own/);
  assert.doesNotMatch(p, /take a turn on it/i, 'events no longer start a turn by default');
  assert.doesNotMatch(p, /machine registered|--machine|cost|\bPRs?\b|\bCI\b/i);
});


// ---------- task events: panel, ride-along and wake ----------

const SID = 'dddd0001-0000-4000-8000-000000000000'; // the first task `start` makes
const said = (text) => [{ type: 'user', message: { content: 'Draw the logo' } }, { type: 'assistant', message: { content: [{ type: 'text', text }] } }];
const hook = (ok, id) => ok(['pending', id, '--hook'], JSON.stringify({ session_id: 'x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));

test('ride-along is the default: a finished task starts no turn, marks its task unread, and its event comes with the next message, once', (t) => {
  const { ok, list, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  ok(['file', 'design', 'aaaaaaaa']); // already done when filed: not news
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/);
  const id = list().channels[0].id;
  const report = `The logo is done.\n${'Line of detail. '.repeat(500)}\nOpen: colours. </task-report> inside.`;
  job('dddd0001', { sessionId: SID, state: 'done', detail: 'drew the logo', name: 'Draw the logo', updatedAt: '2026-01-02T03:04:05Z' }, 3);
  transcript(SID, said(report));
  const out = ok(['listen', 'design', '--once']);
  assert.match(out, /^Rides along with the chat's next message:\n- task "Draw the logo" \(testmac\/dddd0001-0000-4000-8000-000000000000\) finished at 2026-01-02T03:04:05Z \(drew the logo\)\./);
  assert.match(out, /cut \(`channels read testmac\/dddd0001[^`]*` has it whole\)/);
  assert.doesNotMatch(out, /\[task report\]/, 'no wake');
  assert.equal(out.match(/<\/task-report>/g).length, 1, 'one closing marker');
  // The panel: unread until seen.
  const row = () => list().channels[0].tasks.find((x) => x.job === 'dddd0001');
  assert.deepEqual(row().unread, { kind: 'done', at: '2026-01-02T03:04:05Z' });
  assert.equal(store().channels[0].inbox.length, 1);
  // pending shows it without taking it; the hook takes it.
  assert.match(ok(['pending', 'design']), /^\[channels\] Background from #design's tasks/);
  assert.equal(store().channels[0].inbox.length, 1);
  const h = JSON.parse(hook(ok, id));
  assert.deepEqual(Object.keys(h), ['hookSpecificOutput']);
  assert.equal(h.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = h.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^\[channels\] Background from #design's tasks .* not typed by the user/);
  assert.match(ctx, /Mention an event only if it bears on what the user is saying or blocks something, in one line/);
  assert.match(ctx, /<task-report>\nThe logo is done\.\nLine of detail\./);
  assert.ok(ctx.length < 10000, 'within what Claude Code takes from a hook');
  assert.deepEqual(store().channels[0].inbox, [], 'delivered');
  assert.equal(hook(ok, id), '', 'nothing twice');
  assert.equal(ok(['pending', 'design']).trim(), "Nothing waits for #design's chat.");
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/, 'once');
  assert.match(ok(['seen', SID]), /Marked .* seen/);
  assert.equal(row().unread, null);
  // A hook for a channel that isn't there prints nothing and never fails the message.
  assert.equal(hook(ok, 'ch_nope'), '');
});

test('an unregistered question rides along; a task\'s newer event replaces its older one in the inbox', (t) => {
  const { ok, list, store, job, transcript, live } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  transcript(SID, said('Which colour should it be?'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'which colour?', name: 'Draw the logo' }, 2);
  const q = ok(['listen', 'design', '--once']);
  assert.match(q, /^Rides along.*\n- task "Draw the logo" \(testmac\/dddd0001[^)]*\) is waiting on the user since .*: it asked something; it waits on: which colour\?\./);
  assert.equal(list().channels[0].tasks[0].unread.kind, 'needs');
  live(SID, { status: 'waiting', waitingFor: 'permission for Bash(rm -rf build)' });
  job('dddd0001', { sessionId: SID, state: 'working', name: 'Draw the logo' }, 3);
  assert.match(ok(['listen', 'design', '--once']), /it shows a prompt; it waits on: permission for Bash\(rm -rf build\)/);
  const inbox = store().channels[0].inbox;
  assert.equal(inbox.length, 1, 'one waiting event per task');
  assert.match(inbox[0].text, /permission for Bash/);
  const ctx = JSON.parse(hook(ok, list().channels[0].id)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /permission for Bash/);
  assert.doesNotMatch(ctx, /which colour\?\./);
});

test('a registration wakes the chat once, whole, saying why, and is used up; one that doesn\'t match leaves the event riding along', (t) => {
  const { ok, run, list, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  assert.match(run(['watch', SID, '--wake-on', 'soon']).stderr, /--wake-on is finish, question, any or none/);
  assert.match(run(['watch', 'ffffffff', '--wake-on', 'any']).stderr, /No task testmac\/ffffffff in any channel/);
  assert.match(ok(['watch', SID, '--wake-on', 'finish', '--why', 'the user asked to be told when the logo is done']), /#design's chat is woken the next time testmac\/dddd0001\S* finishes, once\./);
  assert.deepEqual([store().channels[0].tasks[0].wake.on, store().channels[0].tasks[0].wake.why], ['finish', 'the user asked to be told when the logo is done']);
  // A question doesn't match a finish registration: it rides along, and the registration stays.
  transcript(SID, said('Round or square?'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'round or square?', name: 'Draw the logo' }, 2);
  assert.match(ok(['listen', 'design', '--once']), /^Rides along/);
  assert.equal(store().channels[0].tasks[0].wake.on, 'finish');
  // The finish wakes the chat, with the whole message, and takes the task's waiting event with it.
  const report = `Logo drawn.\n${'Line of detail. '.repeat(5000)}`;
  transcript(SID, said(report));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo', updatedAt: '2026-01-02T03:04:05Z' }, 4);
  const w = ok(['listen', 'design', '--once']);
  assert.match(w, /^Wakes the chat with:\n\[task report\] #design · task "Draw the logo" \(testmac\/dddd0001[^)]*\) finished\.\n.*\nWhy you're woken: the user asked to be told when the logo is done\. That registration is now used up\./);
  assert.ok(w.includes(report.trim()), 'a wake carries the whole message');
  assert.equal(store().channels[0].tasks[0].wake, null, 'used up');
  assert.deepEqual(store().channels[0].inbox, []);
  assert.equal(list().channels[0].tasks[0].unread.kind, 'done', 'the panel shows it too');
  // The next finish rides along.
  transcript(SID, said('Redrawn.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 6);
  assert.match(ok(['listen', 'design', '--once']), /^Rides along[\s\S]*Redrawn\./);
  // question and any; none cancels.
  ok(['watch', SID, '--wake-on', 'question']);
  transcript(SID, said('Bigger?'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'bigger?', name: 'Draw the logo' }, 7);
  assert.match(ok(['listen', 'design', '--once']), /^Wakes the chat with:\n\[task question\][\s\S]*Why you're woken: you ran channels watch --wake-on question\. That registration/);
  ok(['watch', SID, '--wake-on', 'any']);
  assert.match(ok(['watch', SID, '--wake-on', 'none']), /won't be woken/);
  transcript(SID, said('Bigger it is.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 8);
  assert.match(ok(['listen', 'design', '--once']), /^Rides along/);
});

test('start --wake-on and send --wake-on register on the task, and on a copy Claude Code starts in its place', (t) => {
  const { ok, home, store, job, transcript, live } = setup(t);
  ok(['create', 'design']);
  assert.match(ok(['start', 'design', '--wake-on', 'any', 'Draw the logo']), /The chat is woken on its next event\./);
  assert.deepEqual([store().channels[0].tasks[0].wake.on, store().channels[0].tasks[0].wake.why], ['any', 'you started it with --wake-on any']);
  transcript(SID, said('Done.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 2);
  assert.match(ok(['listen', 'design', '--once']), /^Wakes the chat with:\n\[task report\][\s\S]*Why you're woken: you started it with --wake-on any\./);
  ok(['file', 'design', 'aaaaaaaa']);
  live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  assert.match(ok(['send', 'aaaaaaaa', '--wake-on', 'finish', 'Also', 'the', 'tax']), /It continues with this as its next message\. The chat is woken when it finishes\./);
  assert.equal(store().channels[0].tasks.find((x) => x.job === 'aaaaaaaa').wake.why, 'you sent it a message with --wake-on finish');
  // A copy carries the registration.
  writeFileSync(join(home, 'resume-copies'), '');
  ok(['send', SID, '--wake-on', 'question', 'Make it blue']);
  const copy = store().channels[0].tasks.find((x) => x.how === 'copied');
  assert.equal(copy.wake.on, 'question');
});

test('dedup: an event identical to the last one recorded for its task is dropped at every level, registered or not', (t) => {
  const { ok, list, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  transcript(SID, said('Logo drawn.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 2);
  assert.match(ok(['listen', 'design', '--once']), /^Rides along/);
  hook(ok, list().channels[0].id);
  ok(['seen', SID]);
  ok(['watch', SID, '--wake-on', 'any']);
  // More work, the same last message: a repeat. No wake, no inbox, no unread, and the registration waits.
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 5);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/);
  assert.deepEqual(store().channels[0].inbox, []);
  assert.equal(list().channels[0].tasks[0].unread, null);
  assert.equal(store().channels[0].tasks[0].wake.on, 'any');
  // The same question twice, with work between: the second is a repeat.
  transcript(SID, said('Which colour should it be?'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'Which colour should it be?', name: 'Draw the logo' }, 6);
  assert.match(ok(['listen', 'design', '--once']), /^Wakes the chat with:\n\[task question\]/);
  ok(['seen', SID]);
  job('dddd0001', { sessionId: SID, state: 'working', name: 'Draw the logo' }, 7);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/);
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'Which colour should it be?', name: 'Draw the logo' }, 8);
  ok(['watch', SID, '--wake-on', 'any']);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/, 'the same question again');
  // A task stopped while it waited (as send does): its finish repeats the question's message.
  job('dddd0001', { sessionId: SID, state: 'stopped', name: 'Draw the logo' }, 9);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/, 'a stop that repeats the question');
  const task = store().channels[0].tasks[0];
  assert.equal(task.told.kind, 'done', 'looked at, so it is not looked at again');
  assert.equal(task.wake.on, 'any');
  assert.equal(list().channels[0].tasks[0].unread, null);
  // New words are news again.
  transcript(SID, said('Blue, then.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 10);
  assert.match(ok(['listen', 'design', '--once']), /^Wakes the chat with:[\s\S]*Blue, then\./);
  // Dismissed: no events.
  ok(['dismiss', SID]);
  transcript(SID, said('More.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 12);
  assert.match(ok(['listen', 'design', '--once']), /Nothing new to report/);
});

test('chat launches claude with the prompt and its own hook; its listener wakes it only on a registration, in its own terminal', (t) => {
  const { home, ok, run, list, lines, job, transcript, projects, dir } = setup(t);
  ok(['create', 'design', '--description', 'Calm.']);
  ok(['start', 'design', 'Draw the logo']);
  ok(['start', 'design', '--wake-on', 'finish', 'Write the tagline']); // dddd0002
  const sid2 = 'dddd0002-0000-4000-8000-000000000000';
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 2);
  transcript(SID, said('Logo drawn. Open: colours.'));
  job('dddd0002', { sessionId: sid2, state: 'done', name: 'Write the tagline' }, 2);
  mkdirSync(join(home, '.claude', 'projects', '-y'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', '-y', `${sid2}.jsonl`), said('Tagline: calm by design.').map((e) => JSON.stringify(e)).join('\n'));
  const bin = join(home, 'cmd');
  const r = run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '1', CHANNELS_BIN: join(bin, 'channels') });
  assert.equal(r.status, 0, r.stderr);
  const c = list().channels[0];
  const [launch] = lines('chat-launches.jsonl');
  assert.deepEqual(launch.args.slice(0, 4), ['--session-id', c.chat.session_id, '-n', '#design']);
  assert.equal(launch.args[4], '--append-system-prompt');
  assert.match(launch.args[5], /<channel-description>\nCalm.\n/);
  assert.deepEqual([launch.cwd, launch.dir, launch.projects, launch.claudecode], [projects, dir, projects, null]);
  assert.ok(launch.path.startsWith(`${bin}:`), 'the chat finds `channels` first on PATH');
  // Its settings: given on the command line, so they reach this session only, with the hook for its channel.
  assert.equal(launch.args[6], '--settings');
  const settings = JSON.parse(launch.args[7]);
  assert.equal(settings.disableAgentView, true);
  assert.equal(settings.promptSuggestionEnabled, false, 'a suggestion would look like a draft to a refresh');
  const [{ hooks: [h] }] = settings.hooks.UserPromptSubmit;
  assert.equal(h.type, 'command');
  assert.ok(h.command.includes(`pending '${c.id}' --hook`), h.command);
  // The task cards mod, for this session only, told which channel it draws and how to run channels.
  assert.deepEqual(launch.args.slice(8), ['--plugin-dir', fileURLToPath(new URL('../mods/claude', import.meta.url))]);
  assert.deepEqual([launch.channel, JSON.parse(launch.argv)], [c.id, [join(bin, 'channels')]]);
  // One wake: the registered task. The other rides along, and the hook, run as Claude Code runs it, attaches it.
  const sends = lines('hc-sends.jsonl');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].terminal, 't42');
  assert.match(sends[0].text, /^\[task report\] #design · task "Write the tagline"[\s\S]*Why you're woken: you started it with --wake-on finish\.[\s\S]*<task-report>\nTagline: calm by design\.\n<\/task-report>/);
  const ran = spawnSync('sh', ['-c', h.command], { encoding: 'utf8', input: '{"prompt":"hi"}', env: { PATH: process.env.PATH, HOME: home, CHANNELS_MACHINE: HERE } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(JSON.parse(ran.stdout).hookSpecificOutput.additionalContext, /task "Draw the logo"[\s\S]*Logo drawn\. Open: colours\./);
  // The next launch resumes the same session once it has a transcript, and has nothing new to say.
  transcript(c.chat.session_id, [{ type: 'user', message: { content: 'hello' } }]);
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '1' }).status, 0);
  assert.deepEqual(lines('chat-launches.jsonl')[1].args.slice(0, 2), ['--resume', c.chat.session_id]);
  assert.equal(lines('hc-sends.jsonl').length, 1);
  assert.ok(existsSync(join(dir, 'listen.log')));
  assert.equal(existsSync(join(dir, `listen-${c.id}.pid`)), false, 'the listener cleans up');
});

test('a wake the chat can\'t take now is kept, with its registration, and arrives on a later look', (t) => {
  const { home, ok, run, lines, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', '--wake-on', 'finish', 'Draw the logo']);
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 2);
  transcript(SID, said('Logo drawn.'));
  writeFileSync(join(home, 'hc-fail'), '');
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '0' }).status, 0);
  assert.equal(lines('hc-sends.jsonl').length, 0);
  assert.equal(store().channels[0].tasks[0].wake.on, 'finish');
  rmSync(join(home, 'hc-fail'));
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't42', FAKE_WAIT_SENDS: '1' }).status, 0);
  assert.match(lines('hc-sends.jsonl')[0].text, /Logo drawn\./);
  assert.equal(store().channels[0].tasks[0].wake, null);
});

// ---------- task cards: what the chat's cards mod reads and runs ----------

test('a waiting event carries its card: a question with the options its message lists, a prompt, a finish', (t) => {
  const { ok, store, job, transcript, live } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  transcript(SID, said('Which colour should the logo be?\n\n1. **Teal**\n2. Coral\n3. `Ink`\n\nI lean teal.'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'which colour?', name: 'Draw the logo' }, 2);
  ok(['listen', 'design', '--once']);
  const [q] = store().channels[0].inbox;
  assert.deepEqual([q.kind, q.card.state, q.card.waiting, q.card.options], ['needs', 'question', 'which colour?', ['Teal', 'Coral', 'Ink']]);
  assert.match(q.card.message, /^Which colour should the logo be\?/);
  live(SID, { status: 'waiting', waitingFor: 'permission for Bash(rm -rf build)' });
  job('dddd0001', { sessionId: SID, state: 'working', name: 'Draw the logo' }, 3);
  ok(['listen', 'design', '--once']);
  assert.deepEqual(store().channels[0].inbox.map((e) => [e.card.state, e.card.waiting, e.card.options]), [['prompt', 'permission for Bash(rm -rf build)', []]]);
  transcript(SID, said('Logo drawn.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 4);
  live('ffffffff-0000-4000-8000-000000000000', {}); // the task's own process record is gone
  ok(['listen', 'design', '--once']);
  assert.deepEqual(store().channels[0].inbox.map((e) => [e.kind, e.card.state, e.card.message]), [['done', 'done', 'Logo drawn.']]);
});

test('options: only a short list at the end of the message counts', async () => {
  const { optionsOf } = await import('../bin/channels.mjs');
  assert.deepEqual(optionsOf('Pick one:\n- Round\n- Square'), ['Round', 'Square']);
  assert.deepEqual(optionsOf('a) Yes\nb) No'), ['Yes', 'No']);
  assert.deepEqual(optionsOf('Done:\n- one thing'), [], 'one item is no choice');
  assert.deepEqual(optionsOf('What should the tagline say?'), []);
  assert.deepEqual(optionsOf(`- ${'x'.repeat(81)}\n- y`), [], 'too long to be an option');
  assert.deepEqual(optionsOf(Array.from({ length: 7 }, (_, i) => `${i + 1}. o${i}`).join('\n')), [], 'too many');
});

test('a question stays a card after it rides along, marked delivered, and goes once the task moves on; a finish leaves with the ride', (t) => {
  const { ok, list, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  transcript(SID, said('Which colour?'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'which colour?', name: 'Draw the logo' }, 2);
  ok(['listen', 'design', '--once']);
  const id = list().channels[0].id;
  assert.match(JSON.parse(hook(ok, id)).hookSpecificOutput.additionalContext, /which colour\?/);
  const [q] = store().channels[0].inbox;
  assert.ok(q.delivered_at, 'still a card, delivered');
  assert.equal(hook(ok, id), '', 'not delivered twice');
  assert.equal(ok(['pending', 'design']).trim(), "Nothing waits for #design's chat.");
  // Answered in its view: it works again, and its card goes.
  job('dddd0001', { sessionId: SID, state: 'working', name: 'Draw the logo' }, 3);
  assert.match(ok(['listen', 'design', '--once']), /Drops testmac\/dddd0001\S*'s question: the task has moved on/);
  assert.deepEqual(store().channels[0].inbox, []);
});

test('card dismiss takes a card quietly; card tell takes it and prints the whole report for the chat', (t) => {
  const { ok, run, list, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  const report = `Logo drawn.\n${'Line of detail. '.repeat(400)}`;
  transcript(SID, said(report));
  job('dddd0001', { sessionId: SID, state: 'done', detail: 'drew it', name: 'Draw the logo', updatedAt: '2026-01-02T03:04:05Z' }, 2);
  ok(['listen', 'design', '--once']);
  assert.equal(list().channels[0].tasks[0].unread.kind, 'done');
  const told = ok(['card', 'tell', SID]);
  assert.match(told, /^\[task report\] #design · task "Draw the logo" \(testmac\/dddd0001[^)]*\) finished\.\n/);
  assert.match(told, /The user pressed Tell chat on its card above the prompt/);
  assert.ok(told.includes(report.trim()), 'whole, not cut as a ride-along is');
  assert.deepEqual(store().channels[0].inbox, [], 'it won\'t ride along too');
  assert.equal(list().channels[0].tasks[0].unread, null, 'seen');
  assert.equal(hook(ok, list().channels[0].id), '');
  transcript(SID, said('Redrawn.'));
  job('dddd0001', { sessionId: SID, state: 'done', name: 'Draw the logo' }, 3);
  ok(['listen', 'design', '--once']);
  assert.match(ok(['card', 'dismiss', SID]), /Dismissed testmac\/dddd0001\S*'s card in #design\./);
  assert.deepEqual(store().channels[0].inbox, []);
  assert.match(ok(['card', 'dismiss', SID]), /had no card waiting/);
  assert.equal(hook(ok, list().channels[0].id), '');
  assert.match(run(['card', 'flip', SID]).stderr, /channels card dismiss\|tell <session>/);
  assert.match(run(['card', 'tell', 'ffffffff']).stderr, /No task testmac\/ffffffff in any channel/);
});

test('an answer sent to a task takes its question card with it', (t) => {
  const { ok, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  transcript(SID, said('Which colour?\n- Teal\n- Coral'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'which colour?', name: 'Draw the logo', cwd: '/' }, 2);
  ok(['listen', 'design', '--once']);
  assert.equal(store().channels[0].inbox.length, 1);
  assert.match(ok(['send', SID, '-'], 'Coral'), /It continues with this as its next message\./);
  assert.deepEqual(store().channels[0].inbox, []);
});

test('open asks the herdr window to show the task, leaving the request for the mod to take once', (t) => {
  const { home, ok, run, dir } = setup(t);
  const app = join(home, 'bin', 'herdr-app');
  writeFileSync(app, `#!/bin/sh\necho "$@" >> '${join(home, 'app-calls')}'\nif [ -f '${join(home, 'app-fail')}' ]; then echo 'no window' >&2; exit 1; fi\nexit 0\n`);
  chmodSync(app, 0o755);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  const extra = { CHANNELS_HERDR_APP: app, CHANNELS_HERDR_MOD: 'channels-2' };
  assert.match(ok(['open', SID], '', extra), /Asked herdr to show testmac\/dddd0001\S* in #design's tasks panel\./);
  assert.equal(readFileSync(join(home, 'app-calls'), 'utf8'), 'do channels-2.open-task\n');
  const want = JSON.parse(ok(['open', '--take']));
  assert.deepEqual([want.task, want.channel], [`${HERE}/${SID}`, 'design']);
  assert.equal(ok(['open', '--take']).trim(), 'null', 'taken once');
  writeFileSync(join(home, 'app-fail'), '');
  assert.match(run(['open', SID], '', extra).stderr, /The herdr window didn't take it: no window/);
  assert.equal(existsSync(join(dir, 'open.json')), false);
});

test('rename-task renames the background session in Claude Code, as its agents view does, and the task\'s card', (t) => {
  const { home, ok, run, list, store, job, transcript } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  const state = () => JSON.parse(readFileSync(join(home, '.claude', 'jobs', 'dddd0001', 'state.json'), 'utf8'));
  transcript(SID, said('Which colour?\n- Teal\n- Coral'));
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'which colour?', name: 'Draw the logo', nameSource: 'auto', cwd: '/', detail: 'asked' }, 2);
  ok(['listen', 'design', '--once']);
  assert.equal(store().channels[0].inbox[0].name, 'Draw the logo');
  const out = ok(['rename-task', SID, 'Logo,', 'second', 'try']);
  assert.match(out, new RegExp(`Renamed ${HERE}/${SID} in #design to "Logo, second try" in Claude Code: \`claude agents\` shows the new name\\.`));
  // Only the name changes in the job's record, marked as the user's, as Claude Code's own rename writes it.
  const s = state();
  assert.deepEqual([s.name, s.nameSource, s.sessionId, s.state, s.needs, s.detail], ['Logo, second try', 'user', SID, 'blocked', 'which colour?', 'asked']);
  assert.ok(Date.parse(s.updatedAt) > Date.now() - 60_000);
  assert.equal(list().channels[0].tasks[0].name, 'Logo, second try');
  assert.equal(store().channels[0].tasks[0].name, 'Logo, second try');
  assert.equal(store().channels[0].tasks[0].named, undefined, 'Claude Code holds the name');
  assert.equal(store().channels[0].inbox[0].name, 'Logo, second try', 'the card shows it');
  // By a short session id or the job too, and refused when empty or too long.
  assert.match(ok(['rename-task', 'dddd0001', 'Logo']), /to "Logo" in Claude Code/);
  assert.match(run(['rename-task', SID, '  ']).stderr, /A task name needs some text/);
  assert.match(run(['rename-task', SID, 'x'.repeat(81)]).stderr, /one line of up to 80 characters/);
  assert.match(run(['rename-task', 'nope0000']).stderr, /channels rename-task <session> <new-name>/);
  assert.equal(state().name, 'Logo');
});

test('rename-task renames a task\'s copies with it, and a renamed copy keeps the name', (t) => {
  const { home, ok, list, live, job, store } = setup(t);
  ok(['create', 'general']);
  ok(['file', 'general', 'aaaaaaaa', '--name', 'Pick the colour']);
  live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  writeFileSync(join(home, 'resume-copies'), '');
  const [, copyJob] = /\(job (eeee\d{4})\)/.exec(ok(['send', OLD, 'Blue.'])) ?? [];
  const copy = `${copyJob}-0000-4000-8000-000000000000`;
  const state = (j) => JSON.parse(readFileSync(join(home, '.claude', 'jobs', j, 'state.json'), 'utf8'));
  assert.equal(state(copyJob).nameSource, 'auto');
  assert.match(ok(['rename-task', copy, 'Colour scheme']), /in Claude Code, with its 1 copy/);
  for (const j of ['aaaaaaaa', copyJob]) assert.deepEqual([state(j).name, state(j).nameSource], ['Colour scheme', 'user']);
  assert.deepEqual(store().channels[0].tasks.map((x) => x.name), ['Colour scheme', 'Colour scheme']);
  const shown = Object.fromEntries(list('--all').channels[0].tasks.map((x) => [x.session_id, x.name]));
  assert.deepEqual(shown, { [OLD]: 'Colour scheme', [copy]: 'Colour scheme' });
  // Claude Code renaming the copy later (from /rename in it) shows too: its job's name is the user's now.
  job(copyJob, { ...state(copyJob), name: 'Palette' });
  assert.equal(list().channels[0].tasks[0].name, 'Palette');
});

test('rename-task keeps the name in the store for a session Claude Code can\'t rename from outside, and says so', (t) => {
  const { home, ok, run, list, store, transcript } = setup(t);
  ok(['create', 'general']);
  ok(['file', 'general', GONE]);
  assert.equal(list().channels[0].tasks[0].name, 'Old talk');
  const out = ok(['rename-task', GONE, 'New talk']);
  assert.match(out, new RegExp(`${HERE}/${GONE} isn't a background session, so Claude Code can't rename it from outside \\(only /rename inside does\\): the panel shows "New talk", \`claude agents\` keeps the old name\\.`));
  assert.deepEqual([store().channels[0].tasks[0].name, store().channels[0].tasks[0].named], ['New talk', 'user']);
  assert.equal(list().channels[0].tasks[0].name, 'New talk', 'over the transcript\'s title');
  assert.equal(existsSync(join(home, '.claude', 'jobs', GONE)), false, 'nothing of Claude Code\'s is written');
  assert.match(readFileSync(join(home, '.claude', 'projects', '-x', `${GONE}.jsonl`), 'utf8'), /"customTitle":"Old talk"/);
  // A session that is no task: a background one is renamed in Claude Code alone, another is refused.
  assert.match(ok(['rename-task', 'aaaaaaaa', 'Total fix']), new RegExp(`Renamed ${HERE}/${OLD} to "Total fix" in Claude Code`));
  assert.equal(JSON.parse(readFileSync(join(home, '.claude', 'jobs', 'aaaaaaaa', 'state.json'), 'utf8')).nameSource, 'user');
  transcript('99999999-0000-4000-8000-000000000000', [{ type: 'user', cwd: '/', message: { content: 'hi' } }]);
  assert.match(run(['rename-task', '99999999-0000-4000-8000-000000000000', 'X']).stderr, /isn't a background session, so Claude Code can't rename it from outside: use \/rename in the session itself/);
});

test('renameJob writes the name again when the session\'s own write lost it', async (t) => {
  const { renameJob } = await import('../bin/channels.mjs');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'channels-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, '.claude', 'jobs', 'j1', 'state.json');
  mkdirSync(join(home, '.claude', 'jobs', 'j1'), { recursive: true });
  const before = { sessionId: 's', state: 'working', name: 'auto name', nameSource: 'auto', detail: 'a' };
  writeFileSync(file, JSON.stringify(before));
  let sleeps = 0;
  // The session writes its state from what it read before the rename, once.
  const deps = { home, sleep: async () => { if (sleeps++ === 0) writeFileSync(file, JSON.stringify({ ...before, detail: 'b' })); } };
  assert.equal(await renameJob(deps, 'j1', 'Mine'), true);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([s.name, s.nameSource, s.detail], ['Mine', 'user', 'b']);
  assert.equal(await renameJob(deps, 'nope', 'Mine'), false);
  assert.equal(await renameJob(deps, '../j1', 'Mine'), false);
});

// ---------- Remote Control ----------

const RC = { CHANNELS_REMOTE_CONTROL: '1' };
const BRIDGE = '01AbCdEfGhIjKlMnOpQrStUv';
const rewriteJob = (home, id, state) => writeFileSync(join(home, '.claude', 'jobs', id, 'state.json'), JSON.stringify(state));

test('Remote Control on: start passes --remote-control with the task\'s name; send still passes no flags; off passes neither', (t) => {
  const { home, ok, lines, live, list } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo'], '', RC);
  assert.deepEqual(lines('claude-calls.jsonl')[0].args, ['--bg', '--remote-control', 'Draw the logo', '-n', 'Draw the logo', '--permission-mode', 'auto', 'Draw the logo']);
  for (const off of ['', '0', 'off']) {
    ok(['start', 'design', 'Write the tagline'], '', { CHANNELS_REMOTE_CONTROL: off });
    assert.equal(lines('claude-calls.jsonl').at(-1).args.includes('--remote-control'), false, `CHANNELS_REMOTE_CONTROL=${off}`);
  }
  assert.equal(list().remote_control, false);
  assert.equal(JSON.parse(ok(['list', '--json'], '', RC)).remote_control, true);
  // send: Claude Code resumes a background session with the options it started with, so no flag is passed (a flag
  // on a resume would start a copy).
  ok(['file', 'design', 'aaaaaaaa']);
  live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  ok(['send', 'aaaaaaaa', 'Blue.'], '', RC);
  assert.deepEqual(lines('claude-calls.jsonl').at(-1).args, ['--bg', '--resume', OLD, "From the user via #design's chat: Blue."]);
  // A copy Claude Code starts in its place doesn't get the flag: send says so when Remote Control is on.
  rewriteJob(home, 'aaaaaaaa', { sessionId: OLD, state: 'done', name: 'Fix the total' });
  live(OLD, { status: 'idle', jobId: 'aaaaaaaa' });
  writeFileSync(join(home, 'resume-copies'), '');
  assert.match(ok(['send', OLD, 'Green.'], '', RC), /The copy isn't on claude\.ai unless Remote Control is on for all sessions in Claude Code's own settings/);
});

test('Remote Control on: the chat gets remoteControlAtStartup in its own settings and a claude.ai name with the machine', async (t) => {
  const { ok, run, list, lines } = setup(t);
  ok(['create', 'design']);
  assert.equal(run(['chat', 'design'], '', { ...RC, HC_TERMINAL_ID: 't1' }).status, 0);
  const c = list().channels[0];
  const [on] = lines('chat-launches.jsonl');
  assert.deepEqual(on.args.slice(0, 6), ['--session-id', c.chat.session_id, '-n', '#design', '--remote-control', `#design · ${HERE}`]);
  const settings = JSON.parse(on.args[on.args.indexOf('--settings') + 1]);
  assert.deepEqual([settings.remoteControlAtStartup, settings.disableAgentView], [true, true]);
  assert.equal(run(['chat', 'design'], '', { HC_TERMINAL_ID: 't1' }).status, 0);
  const off = lines('chat-launches.jsonl')[1];
  assert.equal(off.args.includes('--remote-control'), false);
  assert.equal('remoteControlAtStartup' in JSON.parse(off.args[off.args.indexOf('--settings') + 1]), false);
  const { chatArgs, remoteChatName } = await import('../bin/channels.mjs');
  assert.equal(remoteChatName('general', 'studio'), '#general · studio');
  const args = chatArgs({ dir: '/s', name: 'general', id: 'x', resume: true, channelId: 'ch_1', projects: '/p', remote: true });
  assert.deepEqual(args.slice(0, 5), ['--resume', 'x', '-n', '#general', '--remote-control']);
  assert.match(args[5], /^#general · /);
});

test('a task\'s claude.ai link comes from its job record, its live record or its transcript; list, read, link and its card carry it', (t) => {
  const { home, ok, run, list, job, transcript, live, store } = setup(t);
  ok(['create', 'design']);
  ok(['start', 'design', 'Draw the logo']);
  ok(['file', 'design', GONE]);
  const url = `https://claude.ai/code/session_${BRIDGE}`;
  const tasks = () => Object.fromEntries(list().channels[0].tasks.map((x) => [x.session_id, x.remote_url]));
  assert.deepEqual(tasks(), { [SID]: null, [GONE]: null }, 'none before Remote Control');
  assert.match(run(['link', SID]).stderr, /has no claude\.ai link: it has never had Remote Control, which is off for channels on this Mac/);
  // The job's record (cse_…), kept after the process exits.
  job('dddd0001', { sessionId: SID, state: 'blocked', needs: 'which colour?', name: 'Draw the logo', bridgeSessionId: `cse_${BRIDGE}` }, 2);
  transcript(SID, said('Which colour?\n\n1. Teal\n2. Coral'));
  assert.equal(tasks()[SID], url);
  // A session with no job: its running process's record (session_…), else its transcript's last bridge-session line.
  const other = '02ZyXwVuTsRqPoNmLkJiHgFe';
  transcript(GONE, [{ type: 'user', message: { content: 'hi' } }, { type: 'bridge-session', sessionId: GONE, bridgeSessionId: `cse_${other}` }]);
  assert.equal(tasks()[GONE], `https://claude.ai/code/session_${other}`);
  live(GONE, { status: 'idle', bridgeSessionId: `session_${BRIDGE}` });
  assert.equal(tasks()[GONE], url);
  // read and link.
  assert.match(ok(['read', SID]), new RegExp(`^On claude\\.ai: ${url}$`, 'm'));
  assert.equal(JSON.parse(ok(['read', SID, '--json'])).summary.remote_url, url);
  assert.equal(ok(['link', SID]).trim(), url);
  const opener = join(home, 'bin', 'open');
  writeFileSync(opener, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(home, 'opened'))}\n`);
  chmodSync(opener, 0o755);
  assert.deepEqual(JSON.parse(ok(['link', SID, '--open', '--json'], '', { CHANNELS_OPEN: opener })), { id: `${HERE}/${SID}`, url, opened: true });
  assert.equal(readFileSync(join(home, 'opened'), 'utf8').trim(), url);
  // The waiting event's card carries the link, for its Open on claude.ai.
  ok(['listen', 'design', '--once']);
  assert.equal(store().channels[0].inbox.find((e) => e.task === `${HERE}/${SID}`).remote, url);
});

test('remoteLink and transcriptBridge take only Remote Control session ids', async () => {
  const { remoteLink, transcriptBridge, remoteOn } = await import('../bin/channels.mjs');
  assert.equal(remoteLink(`cse_${BRIDGE}`), `https://claude.ai/code/session_${BRIDGE}`);
  assert.equal(remoteLink(`session_${BRIDGE}`), `https://claude.ai/code/session_${BRIDGE}`);
  for (const bad of [null, '', BRIDGE, 'cse_', 'cse_abc', `cse_${BRIDGE}/../x`, `https://claude.ai/code/session_${BRIDGE}`]) assert.equal(remoteLink(bad), null, `${bad}`);
  const text = [{ type: 'bridge-session', bridgeSessionId: 'cse_01aaaaaaaaaaaaaaaaaaaaaa' }, { type: 'user' }, { type: 'bridge-session', bridgeSessionId: `cse_${BRIDGE}` }].map((l) => JSON.stringify(l)).join('\n');
  assert.equal(transcriptBridge(text), `cse_${BRIDGE}`, 'the last one');
  assert.equal(transcriptBridge('{"type":"user"}'), null);
  assert.deepEqual(['1', 'on', 'YES', 'true', '', '0', 'off', undefined].map((v) => remoteOn({ CHANNELS_REMOTE_CONTROL: v })), [true, true, true, true, false, false, false, false]);
});
