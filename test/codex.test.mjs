// Codex tasks (docs/harnesses.md §3) end to end through the command, against a stand-in for Codex's app-server
// (test/fake-codex.mjs): start with the question rule and the CLAUDE.md fallback, the channel's default harness, a
// question as a notice and a card, an answer, an approval answered from outside, a message queued while it works, a
// finish not reported while a queued message waits, rename, read, file, and Codex off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCodex } from './fake-codex.mjs';
import { endsAsking, parseRollout, QUESTION_RULE, approvalOf } from '../bin/harness/codex.mjs';

const cli = fileURLToPath(new URL('../bin/channels.mjs', import.meta.url));
const HERE = 'testmac';

async function setup(t, { codex = 'on' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-')));
  const home = join(root, 'home');
  const dir = join(root, 'store');
  const projects = join(home, 'projects');
  const codexHome = join(home, '.codex');
  mkdirSync(join(projects, 'site'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const bin = join(root, 'codex');
  writeFileSync(bin, '#!/bin/sh\necho "codex-cli 0.171.0"\n');
  chmodSync(bin, 0o755);
  const socket = join(root, 's.sock');
  const fake = await fakeCodex({ socket, codexHome });
  t.after(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
  const env = {
    ...process.env, HOME: home, CHANNELS_DIR: dir, CHANNELS_PROJECTS: projects, CHANNELS_MACHINE: HERE, CHANNELS_CLAUDE: join(root, 'no-claude'),
    CHANNELS_HC: join(root, 'no-hc'), CHANNELS_UPDATE_CHECK: 'off', CODEX_HOME: codexHome, CHANNELS_CODEX_SOCKET: socket, CHANNELS_CODEX_BIN: bin,
    CHANNELS_CODEX: codex, CHANNELS_PERMISSION_MODE: '',
  };
  delete env.CLAUDECODE;
  const run = (args, input = '') => new Promise((done) => {
    const p = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => done({ status, stdout, stderr }));
    p.stdin.end(input);
  });
  const ok = async (args, input) => { const r = await run(args, input); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout; };
  const store = () => JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8'));
  const list = async () => JSON.parse(await ok(['list', '--json']));
  await ok(['create', 'site']);
  return { run, ok, store, list, fake, projects, dir };
}
const refOf = (out) => /testmac\/[0-9a-f-]{36}/.exec(out)?.[0];
const idOf = (ref) => ref.split('/')[1];

test('a Codex task starts in Codex\'s service with the question rule, CLAUDE.md as the AGENTS.md fallback and Codex\'s default sandbox', async (t) => {
  const { ok, run, store, list, fake, projects } = await setup(t);
  const out = await ok(['start', 'site', '--harness', 'codex', '--repo', 'site', '--name', 'Logo pass', '-'], 'Draw a logo\n');
  assert.match(out, /^Started testmac\/[0-9a-f-]{36} on Codex in #site \(site\): Logo pass/);
  const th = fake.threads.get(idOf(refOf(out)));
  assert.deepEqual(th.params, { cwd: join(projects, 'site'), sandbox: 'workspace-write', approvalPolicy: 'on-request', developerInstructions: QUESTION_RULE, config: { project_doc_fallback_filenames: ['CLAUDE.md'] } });
  assert.equal(th.name, 'Logo pass');
  assert.deepEqual(fake.calls.filter((c) => c.method === 'turn/start').map((c) => c.params.input[0].text), ['Draw a logo\n']);
  const [task] = store().channels[0].tasks;
  assert.deepEqual({ harness: task.harness, codex: task.codex, job: task.job }, { harness: 'codex', codex: { mode: 'service', sandbox: 'workspace-write', approval: 'on-request', model: null }, job: null });
  const l = await list();
  assert.deepEqual(l.harnesses.map((h) => [h.id, h.on, h.installed, h.version]), [['claude', true, false, null], ['codex', true, true, '0.171.0']]);
  const row = l.channels[0].tasks[0];
  assert.deepEqual({ harness: row.harness, standing: row.standing, name: row.name, rc: row.caps.remoteControl, cloud: row.caps.cloud, approvals: row.caps.approvals }, { harness: 'codex', standing: 'ready', name: 'Logo pass', rc: false, cloud: false, approvals: true });
  // A permission mode is Codex's own; a Claude Code one it doesn't have is refused.
  await ok(['start', 'site', '--harness', 'codex', '--permission-mode', 'plan', 'Look only']);
  assert.equal([...fake.threads.values()].at(-1).params.sandbox, 'read-only');
  assert.match((await run(['start', 'site', '--harness', 'codex', '--permission-mode', 'acceptEdits', 'x'])).stderr, /--permission-mode for a Codex task is one of default, auto, plan, bypassPermissions/);
  assert.match((await run(['start', 'site', '--harness', 'codex', '--cloud', '--repo', 'site', 'x'])).stderr, /Codex has no cloud tasks/);
  assert.match((await run(['start', 'site', '--harness', 'gemini', 'x'])).stderr, /A harness is one of claude, codex/);
});

test('a channel\'s default harness: its tasks start there unless start says otherwise', async (t) => {
  const { ok, store, fake } = await setup(t);
  assert.match(await ok(['harness', 'site']), /#site's tasks run on Claude Code \(the default\)/);
  assert.match(await ok(['harness', 'site', '--tasks', 'codex']), /#site's tasks now run on Codex/);
  assert.deepEqual(store().channels[0].harness, { tasks: 'codex' });
  assert.match(await ok(['start', 'site', 'Fix the footer']), / on Codex in #site/);
  assert.equal(fake.threads.size, 1);
  assert.equal((await ok(['list', '--json'])).includes('"harness":{"tasks":"codex","chat":"claude"}'), true);
  await ok(['harness', 'site', '--tasks', 'claude']);
  assert.equal(store().channels[0].harness, undefined);
});

test('a question is a "needs you" notice and a card; the answer is its next turn, and its finish a notice', async (t) => {
  const { ok, store } = await setup(t);
  const ref = refOf(await ok(['start', 'site', '--harness', 'codex', 'ASK about the logo']));
  const asked = await ok(['listen', 'site', '--once']);
  assert.match(asked, new RegExp(`Tells the chat, in one line, and shows its card:\\nTask "ASK about the logo" \\(${ref}\\) needs you: Which colour should the logo use\\?`));
  const entry = store().channels[0].inbox[0];
  assert.deepEqual({ state: entry.card.state, options: entry.card.options, label: entry.label, delivered: Boolean(entry.delivered_at) }, { state: 'question', options: ['Teal', 'Coral', 'Ink'], label: 'Codex', delivered: true });
  assert.match(await ok(['listen', 'site', '--once']), /Nothing new to report/, 'told once');
  assert.match(await ok(['send', ref, 'Teal']), /It continues with this as its next message/);
  assert.deepEqual(store().channels[0].inbox, [], 'the answer takes its card');
  assert.match(await ok(['listen', 'site', '--once']), new RegExp(`Tells the chat, in one line:\\nTask "ASK about the logo" \\(${ref}\\) finished: ok: From the user via #site's chat: Teal`));
  const read = await ok(['read', ref]);
  assert.match(read, /Runs on Codex\./);
  assert.match(read, /Session: I need a decision/);
  assert.match(read, /User: From the user via #site's chat: Teal/);
});

test('an approval is a card with Allow and Deny; approve answers it from outside, and the task goes on', async (t) => {
  const { ok, run, store, fake } = await setup(t);
  const ref = refOf(await ok(['start', 'site', '--harness', 'codex', '--name', 'Check the link', 'APPROVE a curl']));
  assert.match(await ok(['listen', 'site', '--once']), /Rides along with the chat's next message:\n- task "Check the link" .* it shows a prompt; it waits on: Run: curl -sI https:\/\/example\.com \(Check the link works\)/);
  const entry = store().channels[0].inbox[0];
  assert.deepEqual(entry.card, { state: 'approval', waiting: 'Run: curl -sI https://example.com (Check the link works)', message: null, options: [], command: 'curl -sI https://example.com', reason: 'Check the link works', approval: 'command' });
  assert.match((await run(['send', ref, 'hello'])).stderr, /is waiting on an approval: answer it first/);
  assert.match(await ok(['read', ref]), /Answer it with: channels approve testmac\/.* allow\|deny/);
  assert.match(await ok(['approve', ref, 'allow']), /Allowed `curl -sI https:\/\/example\.com` for testmac\/.*: it goes on\./);
  assert.ok(fake.calls.some((c) => c.method.startsWith('reply:') && c.params?.decision === 'accept'));
  assert.deepEqual(store().channels[0].inbox, []);
  assert.match(await ok(['listen', 'site', '--once']), /finished: The link works: HTTP\/2 200\./);
  assert.match((await run(['approve', ref, 'allow'])).stderr, /has no approval waiting/);
  // Deny: the turn goes on without it.
  const ref2 = refOf(await ok(['start', 'site', '--harness', 'codex', 'APPROVE again']));
  assert.match(await ok(['approve', ref2, 'deny']), /Denied .*: it goes on without it\./);
  assert.match(await ok(['listen', 'site', '--once']), /finished: I left the link unchecked/);
});

test('a message to a working Codex task is queued (with an id of its own); a queued message keeps it from reading as finished', async (t) => {
  const { ok, fake } = await setup(t);
  const ref = refOf(await ok(['start', 'site', '--harness', 'codex', 'WORK on it']));
  assert.match(await ok(['send', ref, 'and the footer too']), /It is working: Codex runs this as its next message once the current turn ends\./);
  const add = fake.calls.find((c) => c.method === 'thread/queue/add');
  assert.match(add.params.clientUserMessageId, /^[0-9a-f-]{36}$/);
  // The turn ends with the message still queued: idle for a moment, but no finish.
  const th = fake.threads.get(idOf(ref));
  const queued = th.queue.splice(0);
  fake.finish(th.id, 'First part done.');
  th.queue.push(...queued);
  assert.match(await ok(['listen', 'site', '--once']), /Nothing new to report/);
  assert.equal((await ok(['list', '--json'])).includes('"standing":"working"'), true);
  th.queue.length = 0;
  assert.match(await ok(['listen', 'site', '--once']), /finished: First part done\./);
});

test('rename reaches Codex; read, file and an unloaded thread; a Codex task has no claude.ai link', async (t) => {
  const { ok, run, store, fake } = await setup(t);
  const ref = refOf(await ok(['start', 'site', '--harness', 'codex', 'Hello']));
  assert.match(await ok(['rename-task', ref, 'Greeting']), /Renamed testmac\/.* in #site to "Greeting" in Codex too\./);
  assert.equal(fake.threads.get(idOf(ref)).name, 'Greeting');
  assert.equal((await ok(['list', '--json'])).includes('"name":"Greeting"'), true);
  assert.match((await run(['link', ref])).stderr, /is a Codex task: it has no claude\.ai link/);
  // A thread the daemon unloaded takes a message all the same: loaded again, then the turn.
  fake.unload(idOf(ref));
  assert.match(await ok(['send', ref, 'again']), /It continues/);
  assert.ok(fake.calls.some((c) => c.method === 'thread/resume'));
  // A thread started elsewhere is filed by its id.
  await ok(['dismiss', ref]);
  await ok(['create', 'other']);
  assert.match(await ok(['file', 'other', idOf(ref), '--harness', 'codex', '--name', 'Adopted']), /Filed testmac\/.* into #other: Adopted/);
  const filed = store().channels[1].tasks[0];
  assert.deepEqual({ harness: filed.harness, named: filed.named }, { harness: 'codex', named: 'user' });
  // And without --harness, when Claude Code doesn't know it.
  await ok(['dismiss', ref]);
  assert.match(await ok(['file', 'site', idOf(ref)]), /Filed/);
});

test('an empty Codex session (the panel\'s New Codex session) has a name and no turn', async (t) => {
  const { ok, run, fake } = await setup(t);
  const out = JSON.parse(await ok(['start', 'site', '--harness', 'codex', '--empty', '--name', 'New session', '--json']));
  assert.equal(out.harness, 'codex');
  assert.equal(fake.threads.get(out.session_id).name, 'New session');
  assert.equal(fake.calls.filter((c) => c.method === 'turn/start').length, 0);
  assert.match((await run(['start', 'site', '--empty'])).stderr, /Claude Code sessions with no brief start from the tasks panel/);
});

test('with Codex tasks off, nothing calls Codex: start refuses, and filed tasks stay listed', async (t) => {
  const { ok, run, fake } = await setup(t);
  const ref = refOf(await ok(['start', 'site', '--harness', 'codex', 'Hello']));
  const off = await setup(t, { codex: '' });
  assert.match((await off.run(['start', 'site', '--harness', 'codex', 'x'])).stderr, /Codex tasks are off on this Mac/);
  assert.equal(off.fake.threads.size, 0);
  const l = JSON.parse(await off.ok(['list', '--json']));
  assert.equal(l.harnesses.find((h) => h.id === 'codex').on, false);
  assert.ok(fake.threads.has(idOf(ref)));
  void run;
});

test('the question rule\'s test: a last line ending with "?", or a short list of options', () => {
  assert.equal(endsAsking('I changed nothing.\n\nWhich app should I update?'), true);
  assert.equal(endsAsking('Pick one:\n1. Teal\n2. Coral'), true);
  assert.equal(endsAsking('**Which one?**'), true);
  assert.equal(endsAsking('Done. Should greet() take a title too? Do what you think is best.'), false);
  assert.equal(endsAsking('Fixed the bug in util.js.'), false);
  assert.equal(endsAsking('1. one\n2. two'), false, 'a bare list is no question');
  assert.equal(endsAsking(''), false);
});

test('a session file read as channels reads it', () => {
  const line = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
  const text = [
    line('session_meta', { id: 'x', cwd: '/p' }),
    line('event_msg', { type: 'task_started' }),
    line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] }),
    line('response_item', { type: 'function_call', name: 'exec_command' }),
    line('response_item', { type: 'function_call', name: 'exec_command' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] }),
    line('event_msg', { type: 'task_complete', last_agent_message: 'Fixed.' }),
    line('event_msg', { type: 'task_started' }),
    '{"half a line',
  ].join('\n');
  const r = parseRollout(text);
  assert.deepEqual(r.thread.map((x) => x.who === 'tools' ? `tools:${x.calls}` : `${x.who}:${x.text}`), ['user:Fix it', 'tools:2', 'agent:Fixed.']);
  assert.deepEqual({ cwd: r.cwd, last: r.last.text, turns: r.turns, outcome: r.outcome }, { cwd: '/p', last: 'Fixed.', turns: { started: 2, completed: 1, aborted: 0 }, outcome: null });
  assert.deepEqual(approvalOf({ method: 'item/fileChange/requestApproval', params: { reason: 'Write outside' } }), { kind: 'file_change', command: null, reason: 'Write outside', answerable: true, summary: 'Change files (Write outside)' });
});
