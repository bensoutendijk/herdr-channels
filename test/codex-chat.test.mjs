// A channel's chat on Codex (docs/harnesses.md §4): `channels harness --chat`, the chat's own Codex server with the
// chat's prompt and channels' hook, its thread recorded as the chat, a chat on the other harness kept aside, the
// listener's deliveries over the server (notices as turns, queued behind one that runs; the hook review answered once;
// ride-along news as context while the hook isn't trusted), and refresh for a Codex chat. Codex itself is a stand-in:
// test/fake-codex.mjs for its server, test/fake-codex-bin.mjs for the program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCodex } from './fake-codex.mjs';
import { chatPrompt, readStore, refreshChats, startListener, updateStatus, updateStore } from '../bin/channels.mjs';
import { CHAT_HOOK, chatDraft, chatServerArgs, hookReview, trustAllSelected } from '../bin/harness/codex.mjs';
import * as rpc from '../bin/codex-rpc.mjs';

process.env.CHANNELS_CODEX = '1';
const cli = fileURLToPath(new URL('../bin/channels.mjs', import.meta.url));
const fakeBin = fileURLToPath(new URL('./fake-codex-bin.mjs', import.meta.url));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cxc-')));
  const home = join(root, 'home');
  const dir = join(root, 'store');
  const projects = join(home, 'projects');
  const codexHome = join(home, '.codex');
  mkdirSync(projects, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  // A Claude Code that does nothing but end (the chat on Claude Code, after a switch back).
  const claudeBin = join(root, 'claude');
  writeFileSync(claudeBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.330 (Claude Code)"; fi\nexit 0\n');
  chmodSync(claudeBin, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env, HOME: home, CHANNELS_DIR: dir, CHANNELS_PROJECTS: projects, CHANNELS_MACHINE: 'testmac', CHANNELS_CLAUDE: claudeBin,
    CHANNELS_HC: join(root, 'no-hc'), CHANNELS_UPDATE_CHECK: 'off', CODEX_HOME: codexHome, CHANNELS_CODEX_BIN: fakeBin, CHANNELS_CODEX: '1',
    FAKE_CODEX_LOG: join(root, 'codex.jsonl'), FAKE_CODEX_THREADS: join(root, 'threads.jsonl'),
  };
  delete env.CLAUDECODE;
  delete env.HC_TERMINAL_ID;
  const run = (args, input = '', extra = {}) => new Promise((done) => {
    const p = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => done({ status, stdout, stderr }));
    p.stdin.end(input);
  });
  const ok = async (args, input, extra) => { const r = await run(args, input, extra); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout; };
  const lines = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, home, dir, projects, codexHome, env, run, ok, lines };
}

test('harness --chat: the channel\'s chat runs on Codex; list says so; Codex off or not installed refuses', async (t) => {
  const s = setup(t);
  await s.ok(['create', 'site']);
  assert.match(await s.ok(['harness', 'site']), /tasks run on Claude Code \(the default\); its chat runs on Claude Code \(the default\)/);
  assert.match(await s.ok(['harness', 'site', '--chat', 'codex']), /#site's chat now runs on Codex\.$/m);
  assert.deepEqual(JSON.parse(await s.ok(['harness', 'site', '--json'])), { channel: 'site', tasks: 'claude', chat: 'codex' });
  // Setting the tasks' harness leaves the chat's.
  await s.ok(['harness', 'site', '--tasks', 'codex']);
  assert.deepEqual(readStore(s.dir).channels[0].harness, { tasks: 'codex', chat: 'codex' });
  const listed = JSON.parse(await s.ok(['list', '--json']));
  assert.deepEqual(listed.channels[0].harness, { tasks: 'codex', chat: 'codex' });
  assert.ok(listed.features.includes('chat-harness'));
  const off = await s.run(['harness', 'site', '--chat', 'codex'], '', { CHANNELS_CODEX: '0' });
  assert.equal(off.status, 1);
  assert.match(off.stderr, /Codex tasks are off/);
  const missing = await s.run(['harness', 'site', '--chat', 'codex'], '', { CHANNELS_CODEX_BIN: join(s.root, 'nowhere') });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /isn't installed here/);
});

test('a Codex chat: its own server with the chat\'s prompt and the hook, a thread named #<channel> recorded as the chat, Codex\'s TUI on it', async (t) => {
  const s = setup(t);
  await s.ok(['create', 'site']);
  await s.ok(['harness', 'site', '--chat', 'codex']);
  await s.ok(['chat', 'site']);
  const c = readStore(s.dir).channels[0];
  assert.equal(c.chat.harness, 'codex');
  assert.equal(c.chat.machine, 'testmac');
  const calls = s.lines('codex.jsonl');
  const server = calls.find((x) => x.args[0] === 'app-server');
  const socket = server.args[2].replace('unix://', '');
  assert.equal(socket, join(s.dir, `codex-${c.id}.sock`));
  // Settings for this server only (-c), never the user's config: the chat's prompt and the hook.
  assert.match(server.args.find((a) => a.startsWith('developer_instructions=')), /one long-lived Codex session on this Mac/);
  assert.ok(server.args.includes(`hooks.UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(CHAT_HOOK)},timeout=10}]}]`));
  // The hook's command is the same text for every chat: what it needs comes from the server's environment.
  assert.deepEqual(server.env, { CHANNELS_CHANNEL: c.id, CHANNELS_DIR: s.dir, CHANNELS_NODE: process.execPath, CHANNELS_SCRIPT: cli });
  const tui = calls.find((x) => x.args[0] === '--remote');
  assert.deepEqual(tui.args, ['--remote', `unix://${socket}`, 'resume', c.chat.session_id]);
  const threads = await until(() => s.lines('threads.jsonl').at(-1));
  assert.equal(threads[0].id, c.chat.session_id);
  assert.equal(threads[0].name, '#site');
  assert.equal(threads[0].params.cwd, s.projects);
  assert.match(threads[0].params.developerInstructions, /You are the standing chat of the channel #site/);
  assert.equal(threads[0].params.approvalsReviewer, 'auto_review', 'Codex\'s reviewer answers its requests to leave the sandbox');
  assert.equal(existsSync(join(s.dir, `chat-${c.id}.json`)), false, 'the chat\'s record goes when it ends');
  await until(() => !existsSync(socket));
});

test('switching the chat\'s harness keeps the other chat aside, and switching back brings it back', async (t) => {
  const s = setup(t);
  await s.ok(['create', 'site']);
  await s.ok(['chat', 'site']);
  const claudeChat = readStore(s.dir).channels[0].chat;
  assert.equal(claudeChat.harness, undefined);
  await s.ok(['harness', 'site', '--chat', 'codex']);
  await s.ok(['chat', 'site']);
  let c = readStore(s.dir).channels[0];
  assert.equal(c.chat.harness, 'codex');
  assert.deepEqual(c.chat_was, { claude: claudeChat });
  const codexChat = c.chat;
  await s.ok(['harness', 'site', '--chat', 'claude']);
  await s.ok(['chat', 'site']);
  c = readStore(s.dir).channels[0];
  assert.deepEqual(c.chat, claudeChat, 'the Claude Code session resumes');
  assert.deepEqual(c.chat_was, { codex: codexChat });
});

test('the listener in a Codex chat: hook review answered once, ride-along as context until trusted, notices as turns (queued behind one that runs)', async (t) => {
  const s = setup(t);
  await s.ok(['create', 'site']);
  const channelId = readStore(s.dir).channels[0].id;
  const socket = join(s.root, 'chat.sock');
  const hooks = [{ command: CHAT_HOOK, trustStatus: 'untrusted' }];
  const fake = await fakeCodex({ socket, codexHome: s.codexHome, hooks });
  t.after(() => fake.close());
  const c = await rpc.connect({ socket });
  const thread = await rpc.startThread(c, { cwd: s.projects });
  c.close();
  // The chat's screen: Codex's hook review, its cursor on "Review hooks" until a down key moves it.
  const keys = [];
  let cursor = 1;
  const screen = () => (keys.some((k) => k.includes('enter')) ? '› Ask Codex to do anything\n  ? for shortcuts\n'
    : `  Hooks need review\n  1 hook is new or changed.\n\n${[' 1. Review hooks', ' 2. Trust all and continue', ' 3. Continue without trusting (hooks won\'t run)'].map((l, i) => (i + 1 === cursor ? `›${l}` : ` ${l}`)).join('\n')}\n`);
  const deps = {
    home: s.home, projects: s.projects, hc: 'hc', claude: 'claude', codex: fakeBin, codexHome: s.codexHome, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    run: async (cmd, args) => {
      if (args[0] === 'read') return { code: 0, out: screen(), err: '' };
      if (args[0] === 'keys') { keys.push(args.slice(2)); if (args.includes('down')) cursor++; if (args.includes('enter')) hooks[0].trustStatus = 'trusted'; return { code: 0, out: '', err: '' }; }
      return { code: 1, out: '', err: '' };
    },
  };
  // Waiting for the chat: a prompt in a task (rides along) and a finish the gate let through (a notice).
  updateStore(s.dir, (st) => {
    const ch = st.channels[0];
    ch.inbox = [{ task: 'testmac/abc', name: 'Logo', kind: 'needs', at: new Date().toISOString(), text: 'Logo shows a prompt: may it run curl?', card: { state: 'prompt' } }];
    ch.notices = [{ id: 'n-1', task: 'testmac/def', name: 'Copy', at: new Date().toISOString(), text: 'Task testmac/def (Copy) finished: the copy is in.', queued_at: new Date().toISOString(), pushed_at: null }];
  });
  const l = startListener({ dir: s.dir, deps, channelId, terminal: 't9', codex: { socket, threadId: thread.id } });
  t.after(() => l.stop());
  const th = fake.threads.get(thread.id);
  await until(() => th.injected.length);
  assert.match(th.injected[0].content[0].text, /\[channels\] Background from #site/);
  assert.equal(th.injected[0].role, 'developer');
  assert.equal(readStore(s.dir).channels[0].inbox.filter((e) => !e.delivered_at).length, 0, 'what rode along is delivered');
  await until(() => readStore(s.dir).channels[0].notices.length === 0);
  assert.match(readFileSync(th.path, 'utf8'), /\[task notice\] Task testmac\/def \(Copy\) finished: the copy is in\./);
  // Codex's hook review: down to "Trust all and continue", then enter, once.
  await until(() => hooks[0].trustStatus === 'trusted');
  assert.deepEqual(keys, [['down'], ['enter']]);
  // A notice while the chat works waits behind its turn.
  await rpc.connect({ socket }).then(async (x) => { await rpc.startTurn(x, thread.id, 'WORK on it'); x.close(); });
  updateStore(s.dir, (st) => { st.channels[0].notices = [{ id: 'n-2', task: 'testmac/def', name: 'Copy', at: new Date().toISOString(), text: 'Task testmac/def (Copy) failed.', queued_at: new Date().toISOString(), pushed_at: null }]; });
  await until(() => th.queue.length === 1);
  assert.match(th.queue[0].text, /^\[task notice\] Task testmac\/def \(Copy\) failed\./);
  fake.finish(thread.id);
  await until(() => readFileSync(th.path, 'utf8').includes('Copy) failed.'));
  // Trusted now: what waits rides along with the next message, through the hook, not as context.
  updateStore(s.dir, (st) => { st.channels[0].inbox = [{ task: 'testmac/abc', name: 'Logo', kind: 'done', at: new Date().toISOString(), text: 'Logo finished a turn the user started' }]; });
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(th.injected.length, 1);
  assert.equal(readStore(s.dir).channels[0].inbox.filter((e) => !e.delivered_at).length, 1);
});

test('refresh: a Codex chat behind its Codex or its harness restarts only when idle with an empty prompt', async (t) => {
  const s = setup(t);
  await s.ok(['create', 'site']);
  await s.ok(['harness', 'site', '--chat', 'codex']);
  const channelId = readStore(s.dir).channels[0].id;
  const socket = join(s.root, 'chat.sock');
  const fake = await fakeCodex({ socket, codexHome: s.codexHome });
  t.after(() => fake.close());
  const c = await rpc.connect({ socket });
  const thread = await rpc.startThread(c, { cwd: s.projects });
  c.close();
  // The chat's TUI: a process the restart stops.
  const tui = spawn('sleep', ['30']);
  t.after(() => { try { tui.kill(); } catch { /* gone */ } });
  writeFileSync(join(s.dir, `chat-${channelId}.json`), JSON.stringify({ pid: process.pid, terminal: 't5', session_id: thread.id, harness: 'codex', socket, codex: '0.170.0', agent_pid: tui.pid, started_at: new Date().toISOString(), build: null, loop: true }));
  let screen = '› Ask Codex to do anything\n\n  model · ~/projects\n  ← for agents · ? for shortcuts\n';
  const deps = {
    home: s.home, projects: s.projects, hc: 'hc', claude: join(s.root, 'claude'), codex: fakeBin, codexHome: s.codexHome, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    run: async (cmd, args) => {
      if (cmd === fakeBin && args[0] === '--version') return { code: 0, out: 'codex-cli 0.171.0\n', err: '' };
      if (args[0] === 'get') return { code: 0, out: JSON.stringify({ status: { app: 'codex', state: 'idle' } }), err: '' };
      if (args[0] === 'read') return { code: 0, out: screen, err: '' };
      return { code: 1, out: '', err: '' };
    },
  };
  const status = await updateStatus({ dir: s.dir, deps });
  assert.deepEqual([status.chats[0].behind, status.chats[0].state, status.chats[0].codex, status.harnesses.codex], [['codex'], 'idle', '0.170.0', '0.171.0']);
  // Only a refresh someone asked for (the Refresh button) restarts a chat behind its agent; a draft waits.
  assert.deepEqual((await refreshChats({ dir: s.dir, deps, self: true })).chats, []);
  screen = '› half a thought\n\n  model · ~/projects\n';
  const waits = await refreshChats({ dir: s.dir, deps, claude: true, self: true });
  assert.deepEqual([waits.chats[0].did, waits.chats[0].why], ['waits', 'a draft is typed in its prompt']);
  // A busy thread waits too.
  const x = await rpc.connect({ socket });
  await rpc.startTurn(x, thread.id, 'WORK');
  screen = '› Ask Codex to do anything\n  ? for shortcuts\n';
  const busy = await refreshChats({ dir: s.dir, deps, self: true });
  assert.deepEqual([busy.chats[0].did, busy.chats[0].why], ['waits', 'its Codex thread is busy']);
  fake.finish(thread.id);
  x.close();
  // Idle, empty prompt, and asked for earlier: Codex's TUI is stopped, and the chat's loop starts it again.
  const done = await refreshChats({ dir: s.dir, deps, self: true });
  assert.deepEqual([done.chats[0].did, done.chats[0].behind], ['restarted', ['codex']]);
  await until(() => tui.exitCode !== null || tui.signalCode !== null);
  assert.equal(JSON.parse(readFileSync(join(s.dir, `restart-${channelId}.json`), 'utf8')).pid, process.pid);
  // The channel's chat now asked on Claude Code: behind on its harness, which needs no asking.
  await s.ok(['harness', 'site', '--chat', 'claude']);
  const after = await updateStatus({ dir: s.dir, deps });
  assert.ok(after.chats[0].behind.includes('harness'));
});

test('the chat\'s prompt names its harness; a Codex chat has no cards, and runs channels outside its sandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'cxp-'));
  try {
    const claudeP = chatPrompt(root, 'site', { projects: '/p' });
    const codexP = chatPrompt(root, 'site', { projects: '/p', harness: 'codex' });
    assert.match(claudeP, /one long-lived Claude Code session/);
    assert.match(claudeP, /A card above this chat's prompt/);
    assert.match(claudeP, /<channel source="tasks"> event/);
    assert.match(codexP, /one long-lived Codex session/);
    assert.doesNotMatch(codexP, /card above|<channel source=|Tell chat|Bash/);
    assert.match(codexP, /This chat has no task cards: the tasks panel marks the task as waiting/);
    assert.match(codexP, /a message opening with "\[task notice\]" \(sent by the channels listener, not typed by the user\)/);
    assert.match(codexP, /outside the sandbox: ask for escalated permissions/);
    assert.match(codexP, /`channels approve <session> allow\|deny` answers it/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reading a Codex chat\'s screen: an empty prompt (a placeholder) or a draft, and the hook review', () => {
  assert.equal(chatDraft('…\n› Ask Codex to do anything\n\n  gpt · ~/projects · #site\n  ← for agents · ? for shortcuts\n'), '');
  assert.equal(chatDraft('…\n› Explain this codebase\n\n  ? for shortcuts\n'), '');
  assert.equal(chatDraft('…\n› Ask Codex to do anything\n\n  gpt · ~/projects · #site\n                ⚠ 1 warning · f2 to view\n'), 'Ask Codex to do anything');
  assert.equal(chatDraft('› hello\n• ok: hello\n› draft\n  gpt · ~/projects\n'), 'draft');
  assert.equal(chatDraft('no prompt here'), null);
  const review = '  Hooks need review\n  1 hook is new or changed.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won\'t run)\n';
  assert.ok(hookReview(review));
  assert.equal(trustAllSelected(review), false);
  assert.ok(trustAllSelected(review.replace('› 1.', '  1.').replace('  2. Trust', '› 2. Trust')));
  assert.equal(hookReview('› Ask Codex to do anything'), false);
  const args = chatServerArgs({ socket: '/s/x.sock', prompt: 'Say "hi"\nthen go' });
  assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'unix:///s/x.sock']);
  assert.equal(args[4], 'developer_instructions="Say \\"hi\\"\\nthen go"');
});
