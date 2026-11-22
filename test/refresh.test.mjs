// Updates: chats pick up a new herdr-channels build or Claude Code by restarting when idle, never mid-turn, on the same
// session. These run the real `channels chat` in its restart loop, with stand-ins for claude and hc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, promptDraft, refreshChats, refreshSummary, runsChat } from '../bin/channels.mjs';

const cli = fileURLToPath(new URL('../bin/channels.mjs', import.meta.url));

// hc: `run` records a terminal; `get` and `read` show the terminal's status and its prompt, with the draft the test
// types (the files hcstate and draft); `send` is recorded.
const FAKE_HC = (home) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = ${JSON.stringify(home)};
const args = process.argv.slice(2);
const at = (f) => path.join(home, f);
const file = at('hc-terms.json');
const terms = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const log = (f, x) => fs.appendFileSync(at(f), JSON.stringify(x) + '\\n');
if (args[0] === 'ls') { process.stdout.write(JSON.stringify({ terminals: [] })); process.exit(0); }
const read = (f, d) => (fs.existsSync(at(f)) ? fs.readFileSync(at(f), 'utf8') : d);
if (args[0] === 'get') { const t = terms[args[1]]; const status = { app: 'claude-code', state: read('hcstate', 'done').trim() }; process.stdout.write(JSON.stringify(t ? { address: t.address, argv: t.argv, state: t.state, status } : { address: args[1], status })); process.exit(0); }
// The prompt: what is typed (draft plus keys), else Claude Code's greyed suggestion, which looks the same in text.
if (args[0] === 'read') { const typed = read('draft', '') + read('typed', ''); process.stdout.write('… the conversation …\\n' + '─'.repeat(40) + '\\n\u276f ' + (typed || read('suggestion', '')) + '\\n' + '─'.repeat(40) + '\\n  ? for shortcuts\\n'); process.exit(0); }
if (args[0] === 'keys') { let t = read('typed', ''); for (const k of args.slice(2)) t = k === 'backspace' ? t.slice(0, -1) : t + k; fs.writeFileSync(at('typed'), t); log('hc-keys.jsonl', { terminal: args[1], keys: args.slice(2) }); process.exit(0); }
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const argv = args.slice(args.indexOf('--') + 1);
  const n = Object.keys(terms).length;
  terms[name] = { address: 't' + (n + 10), argv, state: 'live' };
  fs.writeFileSync(file, JSON.stringify(terms));
  log('hc-runs.jsonl', { argv, name });
  process.stdout.write(JSON.stringify({ address: terms[name].address, name, state: 'live' })); process.exit(0);
}
if (args[0] === 'send') { log('hc-sends.jsonl', { terminal: args[1], text: args[2] }); process.exit(0); }
process.exit(2);
`;

// claude as a chat: records itself in ~/.claude/sessions with the version and status the test sets, until it is
// stopped (SIGTERM, as a refresh stops it), recording that.
const FAKE_CLAUDE = (home) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = ${JSON.stringify(home)};
const args = process.argv.slice(2);
const at = (f) => path.join(home, f);
const read = (f, d) => (fs.existsSync(at(f)) ? fs.readFileSync(at(f), 'utf8').trim() : d);
if (args[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }
const id = args[Math.max(args.indexOf('--session-id'), args.indexOf('--resume')) + 1];
// As the native installer has it, bin/claude may link into versions/<version>: that is the version it runs.
const own = path.basename(fs.realpathSync(process.argv[1]));
const version = /^\\d+\\.\\d+\\.\\d+$/.test(own) ? own : read('installed', '2.1.329');
if (args[0] === '--version') { process.stdout.write(version + ' (Claude Code)\\n'); process.exit(0); }
fs.appendFileSync(at('chat-launches.jsonl'), JSON.stringify({ args: args.slice(0, 2), version, build: process.env.FAKE_BUILD ?? null }) + '\\n');
const sessions = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const record = path.join(sessions, process.pid + '.json');
const write = () => fs.writeFileSync(record, JSON.stringify({ pid: process.pid, sessionId: id, version, status: read('status', 'idle') }));
write();
const until = Date.now() + 25000;
const t = setInterval(() => { write(); if (Date.now() > until) process.exit(0); }, 50);
process.on('SIGTERM', () => { fs.appendFileSync(at('stops.jsonl'), JSON.stringify({ id }) + '\\n'); fs.rmSync(record, { force: true }); process.exit(143); });
`;

function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'refresh-')));
  const procs = [];
  t.after(() => {
    for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'hc'), FAKE_HC(home));
  writeFileSync(join(home, 'bin', 'claude'), FAKE_CLAUDE(home));
  chmodSync(join(home, 'bin', 'hc'), 0o755);
  chmodSync(join(home, 'bin', 'claude'), 0o755);
  const dir = join(home, 'store');
  const env = (extra = {}) => ({
    ...process.env, HOME: home, CHANNELS_DIR: dir, CHANNELS_PROJECTS: join(home, 'projects'), CHANNELS_MACHINE: 'testmac',
    CHANNELS_CLAUDE: join(home, 'bin', 'claude'), CHANNELS_HC: join(home, 'bin', 'hc'), HC_TERMINAL_ID: '', CHANNELS_BIN: '', ...extra,
  });
  const ok = (args, extra) => { const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env(extra), timeout: 60000 }); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout; };
  const lines = (f) => (existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const set = (f, v) => writeFileSync(join(home, f), v);
  const build = (id) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'build.json'), JSON.stringify({ id, label: id, at: new Date().toISOString() })); };
  const chatFile = (id) => { try { return JSON.parse(readFileSync(join(dir, `chat-${id}.json`), 'utf8')); } catch { return null; } };
  // Runs a terminal's command as herdr-core would, in the background.
  const runTerminal = (argv, address) => {
    const p = spawn(argv[0], argv.slice(1), { env: env({ HC_TERMINAL_ID: address }), stdio: 'ignore', detached: true });
    procs.push(p);
    return p;
  };
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
    return fn();
  };
  return { home, dir, ok, lines, set, build, chatFile, runTerminal, until };
}

test('versions compare part by part', () => {
  assert.equal(compareVersions('2.1.330', '2.1.329'), 1);
  assert.equal(compareVersions('2.1.329', '2.1.329'), 0);
  assert.equal(compareVersions('2.0.9', '2.1.0'), -1);
  assert.equal(compareVersions('dev', '2.1.0'), null);
});

test('a background chat runs in the restart loop, and is still recognized as a chat', (t) => {
  const { ok, lines } = setup(t);
  ok(['create', 'general']);
  ok(['chat', 'general', '--bg', '--json']);
  const [run] = lines('hc-runs.jsonl');
  assert.deepEqual(run.argv.slice(0, 2), ['/bin/sh', '-c']);
  assert.deepEqual(run.argv.slice(-2), ['chat', 'general']);
  assert.ok(run.argv.includes('CHANNELS_CHAT_LOOP=1'));
  assert.equal(runsChat(run.argv), true);
});

test('a new build restarts an idle chat at once, on the same session in the same terminal; a chat mid-turn waits for the tick after its turn', async (t) => {
  const { ok, lines, set, build, chatFile, runTerminal, until, dir } = setup(t);
  build('b1');
  ok(['create', 'general']);
  const id = JSON.parse(ok(['list', '--json'])).channels[0].id;
  const { address } = JSON.parse(ok(['chat', 'general', '--bg', '--json']));
  runTerminal(lines('hc-runs.jsonl')[0].argv, address);
  const first = await until(() => chatFile(id));
  assert.equal(first.build, 'b1');
  assert.equal(first.loop, true);
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.state === 'idle');

  // Up to date: nothing to do, and the list says so.
  assert.deepEqual(JSON.parse(ok(['list', '--json'])).updates.behind, { channels: 0, claude: 0 });
  assert.match(ok(['refresh', '--auto']), /Every chat is up to date/);

  // A chat mid-turn is never interrupted.
  build('b2');
  set('status', 'busy');
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.state === 'busy');
  const listed = JSON.parse(ok(['list', '--json'])).updates;
  assert.deepEqual([listed.behind, listed.chats[0].behind], [{ channels: 1, claude: 0 }, ['channels']]);
  const waiting = JSON.parse(ok(['refresh', '--auto', '--json']));
  assert.deepEqual(waiting.chats.map((x) => [x.channel, x.did]), [['general', 'waits']]);
  assert.match(waiting.summary, /#general restarts when its turn ends/);
  assert.equal(lines('stops.jsonl').length, 0, 'a busy chat is never stopped');
  assert.equal(chatFile(id).pid, first.pid);

  // Its turn ends, but a draft is typed in the prompt: it waits for that too, and says so.
  set('status', 'idle');
  set('draft', 'half a thought');
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.state === 'idle');
  const drafted = JSON.parse(ok(['refresh', '--auto', '--json']));
  assert.deepEqual(drafted.chats.map((x) => [x.did, x.why]), [['waits', 'a draft is typed in its prompt']]);
  assert.match(drafted.summary, /#general restarts once its prompt is empty/);
  assert.deepEqual(lines('hc-keys.jsonl'), [], 'a chat without prompt suggestions is never typed into');
  // herdr-core says the terminal works (a background command, say): it waits as well.
  set('draft', '');
  set('hcstate', 'working');
  assert.deepEqual(JSON.parse(ok(['refresh', '--auto', '--json'])).chats.map((x) => x.did), ['waits']);
  assert.equal(lines('stops.jsonl').length, 0);
  set('hcstate', 'done');

  // All clear: the tick restarts it.
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.state === 'idle');
  const ticked = JSON.parse(ok(['tick', '--json']));
  assert.deepEqual(ticked.refreshed.map((x) => [x.channel, x.did]), [['general', 'restarted']]);
  assert.equal(lines('stops.jsonl').length, 1, 'its claude was stopped once');
  assert.deepEqual(lines('hc-sends.jsonl'), [], 'nothing typed into the chat');
  const second = chatFile(id);
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual([second.build, second.terminal, second.session_id], ['b2', address, first.session_id]);
  assert.equal(lines('hc-runs.jsonl').length, 1, 'no new terminal');
  assert.equal(lines('chat-launches.jsonl').length, 2);
  assert.ok(/restarted #general's chat/.test(readFileSync(join(dir, 'tick.log'), 'utf8')));
  assert.equal(existsSync(join(dir, `restart-${id}.json`)), false);
});

test('a chat left behind mid-turn restarts itself once its turn is over, with no tick or refresh run', async (t) => {
  const { ok, lines, set, build, chatFile, runTerminal, until } = setup(t);
  build('b1');
  ok(['create', 'general']);
  const id = JSON.parse(ok(['list', '--json'])).channels[0].id;
  const { address } = JSON.parse(ok(['chat', 'general', '--bg', '--json']));
  set('status', 'busy');
  runTerminal(lines('hc-runs.jsonl')[0].argv, address);
  const first = await until(() => chatFile(id));
  build('b2');
  set('status', 'idle');
  // Its listener looks every LISTEN.refreshMs (15 s).
  const second = await until(() => { const c = chatFile(id); return c && c.pid !== first.pid ? c : null; }, 25000);
  assert.ok(second, 'restarted by its listener');
  assert.deepEqual([second.build, second.session_id, second.terminal], ['b2', first.session_id, address]);
  assert.equal(lines('stops.jsonl').length, 1);
});

test('a newer Claude Code is offered, not forced: Refresh restarts the idle chat on it, and the install-time refresh leaves it', async (t) => {
  const { home, ok, lines, chatFile, runTerminal, until } = setup(t);
  // Claude Code's native install: bin/claude links to versions/<version>, and an update relinks it.
  mkdirSync(join(home, 'versions'));
  const install = (v) => {
    writeFileSync(join(home, 'versions', v), readFileSync(join(home, 'bin', 'claude.real')));
    chmodSync(join(home, 'versions', v), 0o755);
    rmSync(join(home, 'bin', 'claude'), { force: true });
    symlinkSync(join(home, 'versions', v), join(home, 'bin', 'claude'));
  };
  renameSync(join(home, 'bin', 'claude'), join(home, 'bin', 'claude.real'));
  install('2.1.329');
  ok(['create', 'general']);
  const id = JSON.parse(ok(['list', '--json'])).channels[0].id;
  const { address } = JSON.parse(ok(['chat', 'general', '--bg', '--json']));
  runTerminal(lines('hc-runs.jsonl')[0].argv, address);
  const first = await until(() => chatFile(id));
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.claude === '2.1.329');
  install('2.1.330');
  const listed = JSON.parse(ok(['list', '--json'])).updates;
  assert.deepEqual([listed.claude, listed.behind, listed.chats[0].claude], ['2.1.330', { channels: 0, claude: 1 }, '2.1.329']);
  assert.match(ok(['refresh', '--auto']), /up to date/, 'an install does not restart chats for Claude Code');
  assert.equal(chatFile(id).pid, first.pid);
  const r = JSON.parse(ok(['refresh', '--json']));
  assert.equal(r.summary, 'Restarted #general on Claude Code 2.1.330.');
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.claude === '2.1.330');
  assert.deepEqual(JSON.parse(ok(['list', '--json'])).updates.behind, { channels: 0, claude: 0 });
  assert.deepEqual(lines('chat-launches.jsonl').map((x) => x.version), ['2.1.329', '2.1.330']);
});

test('a chat started before the restart loop ends when its claude is stopped, and is started again in the loop; its prompt suggestion is told from a draft', async (t) => {
  const { home, dir, ok, lines, set, build, chatFile, runTerminal, until } = setup(t);
  build('b1');
  ok(['create', 'general']);
  const id = JSON.parse(ok(['list', '--json'])).channels[0].id;
  // As an earlier version started it: the chat command alone, no loop. (Under a plain sh, which reaps it the way
  // herdr-core does: this test process is blocked in spawnSync meanwhile, and a zombie still counts as running.)
  const old = runTerminal(['/bin/sh', '-c', '"$@"; exit $?', 'sh', process.execPath, cli, 'chat', 'general'], 't9');
  const first = await until(() => chatFile(id));
  assert.equal(first.loop, false);
  // An earlier version also left prompt suggestions on: its record says nothing about them.
  const { suggestions: _, ...older } = first;
  writeFileSync(join(dir, `chat-${id}.json`), JSON.stringify(older));
  set('suggestion', 'run the tests');
  // A real draft under it: the key typed shows it, so it waits (and the draft is as it was).
  set('draft', 'half');
  build('b2');
  await until(() => JSON.parse(ok(['list', '--json'])).updates.chats[0]?.state === 'idle');
  assert.deepEqual(JSON.parse(ok(['refresh', '--auto', '--json'])).chats.map((x) => x.why), ['a draft is typed in its prompt']);
  assert.equal(readFileSync(join(home, 'typed'), 'utf8'), '', 'the key was taken back');
  set('draft', '');
  // Only the suggestion: the key typed replaces it, so the prompt was empty.
  const r = JSON.parse(ok(['refresh', '--auto', '--json']));
  // The chat's own listener refreshes every LISTEN.refreshMs under the same lock: this one waits it out, never busy.
  assert.equal(r.busy, false, 'the asked-for refresh ran');
  assert.deepEqual(lines('hc-keys.jsonl').map((k) => k.keys.join(' ')), ['x', 'backspace', 'x', 'backspace']);
  assert.deepEqual(r.chats.map((x) => [x.did, x.terminal]), [['restarted', 't10']]);
  await until(() => old.exitCode !== null);
  assert.notEqual(old.exitCode, null, 'an old chat just ends');
  const [run] = lines('hc-runs.jsonl');
  assert.deepEqual(run.argv.slice(0, 2), ['/bin/sh', '-c']);
});

test('a refresh asked for waits out another one (a listener\'s own) instead of answering busy; one not asked for doesn\'t wait', async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'refresh-lock-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'store');
  mkdirSync(dir, { recursive: true });
  const deps = { home, claude: join(home, 'claude'), run: async () => ({ code: 0, out: '2.1.330 (Claude Code)' }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const lock = join(dir, 'refresh.lock');
  writeFileSync(lock, '');
  assert.equal((await refreshChats({ dir, deps })).busy, true, 'a listener\'s refresh just skips its turn');
  assert.ok(existsSync(lock), 'and leaves the other refresh\'s lock alone');
  const freed = setTimeout(() => rmSync(lock, { force: true }), 300);
  t.after(() => clearTimeout(freed));
  const r = await refreshChats({ dir, deps, waitMs: 5000 });
  assert.equal(r.busy, false, 'the asked-for refresh ran once the other finished');
  assert.ok(!existsSync(lock), 'and let go of the lock');
  writeFileSync(lock, '');
  const started = Date.now();
  assert.equal((await refreshChats({ dir, deps, waitMs: 200 })).busy, true, 'past its wait it still answers busy');
  assert.ok(Date.now() - started >= 200);
});

test('the prompt on a chat\'s screen: empty, a draft, or not there', () => {
  const screen = (line) => `… earlier …\n${'─'.repeat(20)}\n${line}\n${'─'.repeat(20)}\n  ⏵⏵ auto mode on\n`;
  assert.equal(promptDraft(screen('\u276f ')), '');
  assert.equal(promptDraft(screen('\u276f\u00a0')), '');
  assert.equal(promptDraft(screen('\u276f fix the build')), 'fix the build');
  assert.equal(promptDraft(screen('\x1b[2m\u276f\x1b[0m wait')), 'wait');
  assert.equal(promptDraft('$ zsh prompt\n'), null);
});

test('a refresh says what it did in one line', () => {
  const r = (chats) => refreshSummary({ busy: false, claude: '2.1.330', chats });
  assert.equal(r([]), 'Every chat is up to date.');
  assert.equal(r([{ channel: 'a', behind: ['claude'], did: 'restarted' }, { channel: 'b', behind: ['channels'], did: 'restarted' }, { channel: 'c', behind: ['claude'], did: 'waits' }]),
    'Restarted #a and #b on Claude Code 2.1.330. #c restarts when its turn ends.');
  assert.equal(r([{ channel: 'a', behind: ['channels'], did: 'restarted' }]), 'Restarted #a.');
  assert.equal(r([{ channel: 'a', behind: ['channels'], did: 'waits', draft: true }]), '#a restarts once its prompt is empty.');
  assert.equal(r([{ channel: 'a', behind: ['channels'], did: 'failed', why: 'it runs outside herdr' }]), "#a couldn't restart: it runs outside herdr.");
  assert.equal(refreshSummary({ busy: true, chats: [] }), 'Another refresh is running.');
});
