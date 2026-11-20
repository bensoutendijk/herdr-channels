// bin/cloud.mjs: the sessions list against a stubbed fetch and login file, start and attach against a stubbed pty,
// send against a stubbed program. Nothing reaches the network or the real login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudError, cloudId, cloudUrl, cseId, listCloudSessions, parseStarted, plain, probeAttach, ptyArgv, sendToCloudSession, sessionOf, startCloudSession,
} from '../bin/cloud.mjs';

const SFX = '01AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'sk-ant-oat01-SECRET-never-shown';

function home(t, { login = { accessToken: TOKEN, expiresAt: Date.now() + 3600_000 }, org = 'org-uuid-1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const creds = join(dir, 'credentials.json');
  if (login) writeFileSync(creds, JSON.stringify({ claudeAiOauth: login }));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: org } }));
  return { dir, creds };
}

const row = (sfx, extra = {}) => ({
  id: `cse_${sfx}`, title: 'Fix the footer', environment_kind: 'anthropic_cloud', status: 'active', worker_status: 'idle', status_bucket: 'completed',
  last_event_at: '2026-11-19T21:04:09.14Z', created_at: '2026-11-19T20:04:16.99Z', status_line: 'line',
  config: { sources: [{ type: 'git_repository', url: 'https://github.com/o/site', revision: 'main' }] },
  external_metadata: { current_branches: { '': 'claude/fix' }, post_turn_summary: { recent_action: 'Fixed the links', needs_action: '', status_detail: 'links fixed' }, usage: { cost_usd: 0.290234 } },
  ...extra,
});

function fakeFetch(pages, seen = []) {
  return async (url, init) => {
    seen.push({ url, headers: init.headers });
    const next = pages.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body } = next;
    return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

test('ids: session_…, cse_… and claude.ai links name the same session; anything else names none', () => {
  for (const raw of [`session_${SFX}`, `cse_${SFX}`, `https://claude.ai/code/session_${SFX}?from=cli&m=0`, `https://claude.ai/code/session_${SFX}`]) {
    assert.equal(cloudId(raw), `session_${SFX}`, raw);
    assert.equal(cseId(raw), `cse_${SFX}`, raw);
    assert.equal(cloudUrl(raw), `https://claude.ai/code/session_${SFX}`, raw);
  }
  for (const bad of [null, '', SFX, 'session_', 'session_abc', `session_${SFX}/../x`, `https://example.com/code/session_${SFX}`, `http://claude.ai/code/session_${SFX}`]) assert.equal(cloudId(bad), null, `${bad}`);
});

test('the list: cloud sessions only, in a few fields, with the login and organization as headers', async (t) => {
  const { dir, creds } = home(t);
  const seen = [];
  const fetch = fakeFetch([{ body: { data: [row(SFX), row('02ZyXwVuTsRqPoNmLkJiHgFe', { environment_kind: 'bridge' }), { id: 'nope' }] } }], seen);
  const list = await listCloudSessions({ fetch, home: dir, credentialsFile: creds, env: {} });
  assert.deepEqual(list, [{
    id: `session_${SFX}`, cse_id: `cse_${SFX}`, url: `https://claude.ai/code/session_${SFX}`, kind: 'anthropic_cloud', title: 'Fix the footer', status: 'active',
    worker_status: 'idle', status_bucket: 'completed', created_at: '2026-11-19T20:04:16.99Z', last_event_at: '2026-11-19T21:04:09.14Z', summary: 'Fixed the links',
    needs: null, detail: 'links fixed', cost_usd: 0.290234, repo: 'https://github.com/o/site', branch: 'claude/fix',
  }]);
  assert.match(seen[0].url, /^https:\/\/api\.anthropic\.com\/v1\/code\/sessions\?limit=100$/);
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers['x-organization-uuid'], 'org-uuid-1');
  assert.equal(seen[0].headers['anthropic-beta'], 'ccr-byoc-2025-07-29');
  const both = await listCloudSessions({ fetch: fakeFetch([{ body: { data: [row(SFX), row('02ZyXwVuTsRqPoNmLkJiHgFe', { environment_kind: 'bridge' })] } }]), home: dir, credentialsFile: creds, env: {}, all: true });
  assert.equal(both.length, 2);
});

test('the list pages while the API says there is more, and stops at a repeat', async (t) => {
  const { dir, creds } = home(t);
  const seen = [];
  const fetch = fakeFetch([
    { body: { data: [row(SFX)], has_more: true, last_id: `cse_${SFX}` } },
    { body: { data: [row('02ZyXwVuTsRqPoNmLkJiHgFe')], has_more: true, last_id: `cse_${SFX}` } },
  ], seen);
  const list = await listCloudSessions({ fetch, home: dir, credentialsFile: creds, env: {} });
  assert.equal(list.length, 2);
  assert.match(seen[1].url, new RegExp(`after_id=cse_${SFX}$`));
  // The second page says the same last id: it stops there, not on a third call that would loop.
  assert.equal(seen.length, 2);
});

test('failures are CloudErrors with a kind, and never carry the token', async (t) => {
  const { dir, creds } = home(t);
  const kinds = async (fetch, opts = {}) => {
    try { await listCloudSessions({ fetch, home: dir, credentialsFile: creds, env: {}, ...opts }); return 'no error'; } catch (err) {
      assert.ok(err instanceof CloudError, String(err));
      assert.ok(!err.message.includes(TOKEN), 'no token in the message');
      assert.ok(!JSON.stringify(err).includes(TOKEN), 'no token on the error');
      return err.kind;
    }
  };
  assert.equal(await kinds(fakeFetch([{ status: 401, body: { error: { message: 'bad token' } } }])), 'auth');
  assert.equal(await kinds(fakeFetch([{ status: 500, body: 'oops' }])), 'http');
  assert.equal(await kinds(fakeFetch([new Error('ECONNREFUSED')])), 'network');
  assert.equal(await kinds(fakeFetch([{ body: '<html>' }])), 'format');
  assert.equal(await kinds(fakeFetch([{ body: { sessions: [] } }])), 'format');
  assert.equal(await kinds(fakeFetch([]), { credentialsFile: join(dir, 'missing.json') }), 'login');
  // An expired login isn't sent at all: Claude Code refreshes it the next time it runs.
  const old = home(t, { login: { accessToken: TOKEN, expiresAt: Date.now() - 1000 } });
  const seen = [];
  await assert.rejects(listCloudSessions({ fetch: fakeFetch([], seen), home: old.dir, credentialsFile: old.creds, env: {} }), (e) => e.kind === 'auth');
  assert.equal(seen.length, 0);
});

test('on macOS the login comes from the Keychain item, read fresh on every call; else the credentials file', async (t) => {
  const { dir } = home(t);
  const calls = [];
  let token = 'first';
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, out: JSON.stringify({ claudeAiOauth: { accessToken: token } }), err: '' }; };
  const seen = [];
  const fetch = fakeFetch([{ body: { data: [] } }, { body: { data: [] } }], seen);
  await listCloudSessions({ fetch, home: dir, platform: 'darwin', exec, env: {} });
  token = 'second';
  await listCloudSessions({ fetch, home: dir, platform: 'darwin', exec, env: {} });
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  assert.deepEqual(seen.map((s) => s.headers.authorization), ['Bearer first', 'Bearer second']);
  // Linux: ~/.claude/.credentials.json, or CLAUDE_CONFIG_DIR's.
  const cfg = mkdtempSync(join(tmpdir(), 'cfg-'));
  t.after(() => rmSync(cfg, { recursive: true, force: true }));
  writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'linux' } }));
  const s2 = [];
  await listCloudSessions({ fetch: fakeFetch([{ body: { data: [] } }], s2), home: dir, platform: 'linux', env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(s2[0].headers.authorization, 'Bearer linux');
  await assert.rejects(listCloudSessions({ fetch: fakeFetch([]), home: dir, platform: 'darwin', exec: async () => ({ code: 44, out: '', err: 'not found' }), env: {} }), (e) => e.kind === 'login' && /Keychain/.test(e.message));
});

test('sessionOf takes what a cloud row has, and nulls for what it lacks', () => {
  const s = sessionOf({ id: `cse_${SFX}`, worker_status: 'requires_action', external_metadata: { post_turn_summary: { needs_action: 'Which file?' } } });
  assert.equal(s.needs, 'Which file?');
  assert.equal(s.cost_usd, null);
  assert.equal(s.title, '');
  assert.equal(sessionOf({ id: 'x' }), null);
});

// A pty stand-in: prints the given chunks, then, like macOS's script, stays until its stdin closes.
function fakePty(chunks, { exitOnStdinEnd = true, code = 0 } = {}) {
  const runs = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let closed = false;
    const close = (c) => { if (!closed) { closed = true; setImmediate(() => child.emit('close', c)); } };
    child.stdin = Object.assign(new EventEmitter(), { end: () => { runs.at(-1).stdinClosed = true; if (exitOnStdinEnd) close(0); } });
    child.kill = () => { runs.at(-1).killed = true; close(null); };
    runs.push({ cmd, args, cwd: opts.cwd, stdinClosed: false, killed: false });
    let i = 0;
    const tick = () => { if (i < chunks.length) { child.stdout.emit('data', chunks[i++]); setTimeout(tick, 5); } else if (!exitOnStdinEnd) close(code); };
    setTimeout(tick, 5);
    return child;
  };
  return { spawnImpl, runs };
}

test('start: claude --cloud under a pty in the repo; its id and link from "View:", then its stdin is closed', async () => {
  const out = ['\x1b[2mCreated cloud session: Fix the footer\x1b[0m\r\n', `View: https://claude.ai/code/session_${SFX}?from=cli&m=0\r\n`, 'Resume with: claude --teleport x\r\n'];
  const { spawnImpl, runs } = fakePty(out);
  const r = await startCloudSession({ brief: "Fix it, don't break it", title: 'Fix the footer', cwd: '/repo', claude: '/bin/claude', platform: 'darwin', spawnImpl });
  assert.equal(r.id, `session_${SFX}`);
  assert.equal(r.url, `https://claude.ai/code/session_${SFX}`);
  assert.equal(r.title, 'Fix the footer');
  assert.deepEqual([runs[0].cmd, runs[0].args], ['script', ['-q', '/dev/null', '/bin/claude', '--cloud', "Fix it, don't break it", '-n', 'Fix the footer']]);
  assert.equal(runs[0].cwd, '/repo');
  assert.equal(runs[0].stdinClosed, true);
  assert.deepEqual(ptyArgv(['claude', '--cloud', "it's"], 'linux'), ['script', ['-qec', "'claude' '--cloud' 'it'\\''s'", '/dev/null']]);
});

test('start: a script that won\'t go once View: arrived is killed; errors, the trust dialog and silence are refused', async () => {
  const stuck = fakePty([`View: https://claude.ai/code/session_${SFX}\n`], { exitOnStdinEnd: false });
  // exitOnStdinEnd false with no more chunks closes itself; make it hang instead by never closing:
  const hang = { ...stuck, spawnImpl: (c, a, o) => { const ch = stuck.spawnImpl(c, a, o); ch.stdin.end = () => {}; ch.removeAllListeners('close'); const emit = ch.emit.bind(ch); ch.emit = (ev, ...x) => (ev === 'close' && !stuck.runs.at(-1).killed ? false : emit(ev, ...x)); return ch; } };
  const r = await startCloudSession({ brief: 'b', cwd: '/r', platform: 'darwin', spawnImpl: hang.spawnImpl });
  assert.equal(r.id, `session_${SFX}`);
  assert.equal(stuck.runs[0].killed, true);
  const err = fakePty(['Error: Cloud sessions are disabled by your organization\'s policy\n'], { exitOnStdinEnd: false, code: 1 });
  await assert.rejects(startCloudSession({ brief: 'b', cwd: '/r', platform: 'darwin', spawnImpl: err.spawnImpl }), (e) => e.kind === 'start' && /disabled by your organization/.test(e.message));
  const trust = fakePty(['Do you trust the files in this folder?\n']);
  await assert.rejects(startCloudSession({ brief: 'b', cwd: '/r', platform: 'darwin', spawnImpl: trust.spawnImpl }), (e) => e.kind === 'trust');
  const quiet = fakePty([], { exitOnStdinEnd: false });
  quiet.spawnImpl = ((inner) => (c, a, o) => { const ch = inner(c, a, o); ch.emit = () => false; return ch; })(quiet.spawnImpl);
  await assert.rejects(startCloudSession({ brief: 'b', cwd: '/r', platform: 'darwin', spawnImpl: quiet.spawnImpl, timeoutMs: 50 }), (e) => e.kind === 'start' && /within 0s|within/.test(e.message));
});

test('parseStarted and plain read what the pty printed', () => {
  assert.equal(parseStarted('nothing'), null);
  assert.deepEqual(parseStarted(`Created cloud session: A b\nView: https://claude.ai/code/session_${SFX}?x=1`), { id: `session_${SFX}`, url: `https://claude.ai/code/session_${SFX}`, title: 'A b' });
  assert.equal(plain('\x1b[1mhi\x1b[0m\r\n\x1b]0;title\x07x'), 'hi\nx');
});

test('send: claude -p <text> --cloud <id> --output-format json; a refusal says why', async () => {
  const calls = [];
  const ok = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, out: `{"ok":true,"session_id":"session_${SFX}","url":"https://claude.ai/code/session_${SFX}?from=cli"}\n`, err: '' }; };
  assert.deepEqual(await sendToCloudSession({ id: `cse_${SFX}`, text: 'Blue.', claude: 'claude', exec: ok }), { id: `session_${SFX}`, url: `https://claude.ai/code/session_${SFX}` });
  assert.deepEqual(calls[0], ['claude', '-p', 'Blue.', '--cloud', `session_${SFX}`, '--output-format', 'json']);
  const no = async () => ({ code: 1, out: '', err: `Error: failed to send message to cloud session session_${SFX}: Session is archived and cannot accept new messages\n` });
  await assert.rejects(sendToCloudSession({ id: `session_${SFX}`, text: 'x', exec: no }), (e) => e.kind === 'send' && /archived/.test(e.message));
  await assert.rejects(sendToCloudSession({ id: 'nope', text: 'x', exec: ok }), (e) => e.kind === 'send');
});

test('probeAttach: off when Claude Code says attaching isn\'t enabled, on when it reached the session, unknown otherwise', async () => {
  const off = fakePty(['Error: Attaching to an existing cloud session is not enabled for your account.\n'], { exitOnStdinEnd: true });
  assert.equal(await probeAttach({ platform: 'darwin', spawnImpl: off.spawnImpl }), 'off');
  assert.deepEqual(off.runs[0].args.slice(2), ['claude', '--cloud', 'session_01000000000000000000000000']);
  const on = fakePty(['Error: Session not found\n']);
  assert.equal(await probeAttach({ platform: 'darwin', spawnImpl: on.spawnImpl }), 'on');
  const other = fakePty(['something else\n'], { exitOnStdinEnd: false });
  assert.equal(await probeAttach({ platform: 'darwin', spawnImpl: other.spawnImpl }), 'unknown');
});
