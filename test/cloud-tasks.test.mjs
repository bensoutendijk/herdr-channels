// Cloud tasks through `channels`, run in this process with a fake cloud (the sessions list, start, send and the attach
// probe) in place of bin/cloud.mjs, and real git for the repo checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHANNELS_MACHINE = 'testmac';
const ch = await import('../bin/channels.mjs');
const { channels, defaultDeps, listenTick, cloudLook, cloudView, CLOUD } = ch;

const SFX = '01AbCdEfGhIjKlMnOpQrStUv';
const SID = `session_${SFX}`;
const URL_ = `https://claude.ai/code/${SID}`;
const OTHER = 'session_02ZyXwVuTsRqPoNmLkJiHgFe';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function setup(t, { on = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cloudtasks-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const was = process.env.CHANNELS_CLOUD;
  process.env.CHANNELS_CLOUD = on ? '1' : '';
  t.after(() => { process.env.CHANNELS_CLOUD = was ?? ''; });
  const projects = join(home, 'projects');
  const site = join(projects, 'site');
  mkdirSync(site, { recursive: true });
  mkdirSync(join(projects, 'plain'), { recursive: true });
  // A repo with a remote (a bare one), pushed.
  git(home, 'init', '-q', '--bare', '-b', 'main', join(home, 'remote.git'));
  git(site, 'init', '-q', '-b', 'main');
  writeFileSync(join(site, 'README.md'), 'hi\n');
  git(site, 'add', '.');
  git(site, 'commit', '-qm', 'one');
  git(site, 'remote', 'add', 'origin', join(home, 'remote.git'));
  git(site, 'push', '-q', '-u', 'origin', 'main');
  const dir = join(home, 'store');
  // The fake cloud: a sessions list the test sets, and what start, send and the probe were asked.
  const fake = { sessions: [], fail: null, lists: 0, started: [], sent: [], probes: 0 };
  const cloud = {
    list: async () => { fake.lists++; if (fake.fail) throw fake.fail; return fake.sessions.map((s) => ({ ...s })); },
    start: async ({ brief, title, cwd }) => { fake.started.push({ brief, title, cwd }); return { id: SID, url: URL_, title }; },
    send: async ({ id, text }) => { fake.sent.push({ id, text }); return { id, url: URL_ }; },
    probe: async () => { fake.probes++; return 'off'; },
  };
  const opened = [];
  const base = defaultDeps(home);
  const deps = {
    ...base, projects, cloud,
    run: async (cmd, args, opts) => (cmd === base.open ? (opened.push(args[0]), { code: 0, out: '', err: '' }) : base.run(cmd, args, opts)),
  };
  // Runs `channels <args>` here: { code, out, err }.
  const cli = async (args, input) => {
    const out = [];
    const err = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    try {
      const code = await channels(args, { deps, dir });
      return { code, out: out.join('\n'), err: err.join('\n') };
    } finally { console.log = log; console.error = error; }
  };
  const ok = async (args) => { const r = await cli(args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}${r.out}`); return r.out; };
  const store = () => JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8'));
  const list = async () => JSON.parse(await ok(['list', '--json']));
  // A session as the list gives it.
  const session = (extra = {}) => ({ id: SID, cse_id: `cse_${SFX}`, url: URL_, kind: 'anthropic_cloud', title: 'Fix the footer', status: 'active', worker_status: 'running', last_event_at: '2026-11-19T20:00:00Z', summary: null, needs: null, detail: null, cost_usd: 0.05, branch: 'claude/fix', ...extra });
  // One listener look, as if CLOUD.pollMs had passed since the last.
  const tick = async (channel = 'design') => {
    const c = store().channels.find((x) => x.name === channel);
    const cache = join(dir, 'cloud.json');
    try { const j = JSON.parse(readFileSync(cache, 'utf8')); j.at = 0; writeFileSync(cache, JSON.stringify(j)); } catch { /* none yet */ }
    return listenTick({ dir, home, channelId: c.id, deliver: async () => true, look: () => cloudLook({ dir, deps }) });
  };
  return { home, dir, projects, site, fake, cli, ok, store, list, session, tick, opened, deps };
}

test('start --cloud: claude --cloud in the repo, filed as cloud/<session_…> with a cloud block; list shows it working with its cost', async (t) => {
  const { ok, fake, store, list, session, site } = setup(t);
  await ok(['create', 'design']);
  const out = await ok(['start', 'design', '--cloud', '--repo', 'site', '--name', 'Fix the footer', 'Fix the footer links']);
  assert.match(out, new RegExp(`^Started cloud/${SID} in #design \\(site, from main on GitHub\\): Fix the footer\\nOn claude\\.ai: ${URL_.replace(/\./g, '\\.')}$`));
  assert.deepEqual(fake.started, [{ brief: 'Fix the footer links', title: 'Fix the footer', cwd: site }]);
  const task = store().channels[0].tasks[0];
  assert.deepEqual([task.machine, task.session_id, task.job, task.name, task.repo, task.how], ['cloud', SID, null, 'Fix the footer', 'site', 'started']);
  assert.deepEqual([task.cloud.url, task.cloud.worker_status, task.cloud.branch], [URL_, 'running', 'main']);
  fake.sessions = [session()];
  const row = (await list()).channels[0].tasks[0];
  assert.equal(row.id, `cloud/${SID}`);
  assert.equal(row.remote_url, URL_);
  assert.deepEqual([row.cloud.state, row.cloud.cost_usd, row.cloud.unknown], ['working', 0.05, null]);
  assert.equal(fake.lists, 1);
  await list();
  assert.equal(fake.lists, 1, 'one call a poll: the second list within CLOUD.pollMs uses what the first learned');
});

test('start --cloud refuses: off, no --repo, a folder that isn\'t a repo, a dirty tree, an unpushed branch, a commit not pushed', async (t) => {
  const { cli, ok, site, fake } = setup(t);
  await ok(['create', 'design']);
  const err = async (args) => { const r = await cli(args); assert.equal(r.code, 1, r.out); return r.err; };
  assert.match(await err(['start', 'design', '--cloud', 'x']), /needs --repo <project>.*Projects: plain, site/);
  assert.match(await err(['start', 'design', '--cloud', '--repo', 'plain', 'x']), /plain isn't a git repository/);
  assert.match(await err(['start', 'design', '--cloud', '--repo', 'site', '--model', 'opus', 'x']), /--model doesn't apply/);
  writeFileSync(join(site, 'new.txt'), 'x');
  assert.match(await err(['start', 'design', '--cloud', '--repo', 'site', 'x']), /site has changes that aren't committed \(1 file\)\. Commit and push first/);
  git(site, 'add', '.');
  git(site, 'commit', '-qm', 'two');
  assert.match(await err(['start', 'design', '--cloud', '--repo', 'site', 'x']), /site's branch main has 1 commit that aren't pushed\. Push first/);
  git(site, 'checkout', '-qb', 'feature');
  assert.match(await err(['start', 'design', '--cloud', '--repo', 'site', 'x']), /site's branch feature isn't on the remote\. Push it first/);
  assert.equal(fake.started.length, 0);
  process.env.CHANNELS_CLOUD = '';
  assert.match(await err(['start', 'design', '--cloud', '--repo', 'site', 'x']), /Cloud tasks are off on this Mac\. Turn them on with `node install\.mjs --cloud`/);
});

test('the listener: working → asks you → done, each once: a question as a notice, a panel dot and a card (no ride-along), gone once answered; a finish as a notice', async (t) => {
  const { ok, fake, store, session, tick } = setup(t);
  await ok(['create', 'design']);
  await ok(['start', 'design', '--cloud', '--repo', 'site', '--name', 'Fix the footer', 'Fix the footer links']);
  const ref = `cloud/${SID}`;
  fake.sessions = [session()];
  assert.deepEqual(await tick(), [], 'working is no event');
  // Idle with no summary yet (a session that has only just been made) is no finish either.
  fake.sessions = [session({ worker_status: 'idle', last_event_at: '2026-11-19T20:00:05Z' })];
  assert.deepEqual(await tick(), []);
  fake.sessions = [session({ worker_status: 'requires_action', last_event_at: '2026-11-19T20:01:00Z', needs: 'Should the /press link go, or point to the media kit?', cost_usd: 0.2 })];
  let did = await tick();
  // requires_action doesn't say a question from a permission prompt, so both are told as a notice, beside the card.
  assert.deepEqual(did.map((e) => [e.level, e.task]), [['asks', ref]]);
  assert.equal(did[0].text, `Cloud task "Fix the footer" (${ref}) needs you: Should the /press link go, or point to the media kit?`);
  let c = store().channels[0];
  assert.deepEqual(c.notices.map((n) => n.text), [did[0].text], 'queued for the notices server');
  assert.ok(c.inbox[0].delivered_at, 'a card, not riding along too');
  assert.match(c.inbox[0].text, /cloud task "Fix the footer" \(cloud\/session_\S+\) is waiting on the user .* the user answers it on claude\.ai/);
  assert.deepEqual(c.tasks[0].unread.kind, 'needs');
  assert.deepEqual(c.inbox[0].card, { state: 'question', waiting: 'Should the /press link go, or point to the media kit?', message: 'Should the /press link go, or point to the media kit?', options: [] });
  assert.equal(c.inbox[0].cloud, true);
  assert.equal(c.inbox[0].remote, URL_);
  assert.equal(c.tasks[0].cloud.cost_usd, 0.2);
  assert.deepEqual(await tick(), [], 'the same state again is no event');
  // Answered on claude.ai: it works again, and the question's card goes.
  fake.sessions = [session({ worker_status: 'running', last_event_at: '2026-11-19T20:02:00Z' })];
  did = await tick();
  assert.deepEqual(did.map((e) => e.level), ['gone']);
  assert.equal(store().channels[0].inbox.length, 0);
  fake.sessions = [session({ worker_status: 'idle', last_event_at: '2026-11-19T20:05:00Z', summary: 'Pointed /press at the media kit and opened PR #31', cost_usd: 0.41 })];
  did = await tick();
  assert.deepEqual(did.map((e) => e.level), ['notice']);
  assert.equal(did[0].text, `Cloud task "Fix the footer" (${ref}) finished: Pointed /press at the media kit and opened PR #31`);
  c = store().channels[0];
  assert.deepEqual([c.inbox, c.notices.map((n) => n.task), c.tasks[0].unread, c.tasks[0].cloud.cost_usd], [[], [ref], null, 0.41]);
  // Seen on claude.ai later: last_event_at moves with the same summary. No new event.
  fake.sessions = [session({ worker_status: 'idle', last_event_at: '2026-11-19T20:09:00Z', summary: 'Pointed /press at the media kit and opened PR #31', cost_usd: 0.41 })];
  assert.deepEqual(await tick(), []);
});

test('the listener wakes the chat on a cloud task when registered, with a cloud question\'s own words; registration is used up', async (t) => {
  const { ok, fake, store, session, tick } = setup(t);
  await ok(['create', 'design']);
  await ok(['start', 'design', '--cloud', '--repo', 'site', '--wake-on', 'question', 'Fix the footer links']);
  fake.sessions = [session({ worker_status: 'requires_action', last_event_at: '2026-11-19T20:01:00Z', needs: 'Which page?' })];
  const did = await tick();
  assert.equal(did[0].level, 'wake');
  assert.match(did[0].text, /^\[task question\] #design · task "Fix the footer" \(cloud\/session_/);
  assert.match(did[0].text, /this cloud task \(a Claude Code session at claude\.ai\/code\) of #design stopped to ask something/);
  assert.match(did[0].text, /They answer it on claude\.ai: Open on its card, or `channels link cloud\/session_\S+ --open`\. Text sent with `channels send` doesn't answer it/);
  assert.equal(store().channels[0].tasks[0].wake, null);
  assert.equal(store().channels[0].inbox.length, 0, 'a wake takes the event: no card');
});

test('only while a channel has an open cloud task, and only with cloud tasks on, is the list called; a failure is "state unknown"', async (t) => {
  const { ok, fake, session, tick, list, dir } = setup(t);
  await ok(['create', 'design']);
  await tick();
  await list();
  assert.equal(fake.lists, 0, 'no cloud task: no call');
  await ok(['start', 'design', '--cloud', '--repo', 'site', 'Fix the footer links']);
  fake.fail = Object.assign(new Error('The cloud sessions list answered 500: oops'), { kind: 'http' });
  await tick();
  assert.equal(fake.lists, 1);
  let row = (await list()).channels[0].tasks[0];
  assert.match(row.cloud.unknown, /answered 500/);
  assert.equal(row.remote_url, URL_, 'Open on the web stays');
  // A 401 waits longer before the next try: Claude Code refreshes the login.
  fake.fail = Object.assign(new Error('401'), { kind: 'auth' });
  const cache = join(dir, 'cloud.json');
  const age = (ms) => { const j = JSON.parse(readFileSync(cache, 'utf8')); j.at = Date.now() - ms; writeFileSync(cache, JSON.stringify(j)); };
  age(CLOUD.pollMs + 1);
  await list();
  assert.equal(fake.lists, 2);
  age(CLOUD.pollMs + 1);
  await list();
  assert.equal(fake.lists, 2, 'after a 401, not again before CLOUD.authWaitMs');
  fake.fail = null;
  fake.sessions = [session()];
  age(CLOUD.authWaitMs + 1);
  row = (await list()).channels[0].tasks[0];
  assert.equal(row.cloud.unknown, null);
  // Off: no call, and the row says why its state is unknown.
  process.env.CHANNELS_CLOUD = '0';
  age(CLOUD.authWaitMs + 1);
  const n = fake.lists;
  row = (await list()).channels[0].tasks[0];
  await tick();
  assert.equal(fake.lists, n);
  assert.equal(row.cloud.unknown, 'cloud tasks are off on this Mac');
  assert.equal((await list()).cloud.on, false);
});

test('cloudView: a list older than CLOUD.staleMs, or one without the session, is unknown', () => {
  const t = { machine: 'cloud', session_id: SID, cloud: { url: URL_, worker_status: 'running' } };
  const now = Date.now();
  assert.match(cloudView(t, { ok_at: now - CLOUD.staleMs - 1, sessions: {} }, { now, on: true }).unknown, /not looked up yet/);
  assert.match(cloudView(t, { ok_at: now, sessions: {} }, { now, on: true }).unknown, /isn't in the account's list/);
  assert.equal(cloudView(t, { ok_at: now, sessions: { [SID]: { id: SID, worker_status: 'requires_action', status: 'active' } } }, { now, on: true }).state, 'needs');
  assert.equal(cloudView(t, { ok_at: now, sessions: { [SID]: { id: SID, worker_status: 'idle', status: 'archived' } } }, { now, on: true }).unknown, 'archived on claude.ai');
});

test('file adopts a cloud session by id, cse id or link; its state then isn\'t news', async (t) => {
  const { ok, cli, fake, store, session, tick } = setup(t);
  await ok(['create', 'design']);
  await ok(['create', 'ops']);
  fake.sessions = [session({ worker_status: 'idle', summary: 'Done already', last_event_at: '2026-11-19T19:00:00Z' }), session({ id: OTHER, url: `https://claude.ai/code/${OTHER}`, title: 'Phone task' })];
  assert.match(await ok(['file', 'design', `https://claude.ai/code/${SID}?from=cli&m=0`]), new RegExp(`^Filed cloud/${SID} into #design: Fix the footer\\nOn claude\\.ai: `));
  assert.match((await cli(['file', 'ops', `cse_${SFX}`])).err, /is a task in #design; dismiss it there first/);
  await ok(['file', 'ops', `cloud/${OTHER}`, '--name', 'My phone task']);
  const s = store();
  assert.equal(s.channels[0].tasks[0].told.kind, 'done');
  assert.deepEqual([s.channels[1].tasks[0].name, s.channels[1].tasks[0].named], ['My phone task', 'user']);
  assert.deepEqual(await tick(), []);
  assert.match((await cli(['file', 'design', 'session_short'])).err, /isn't a cloud session/);
});

test('send: claude -p … --cloud, with the channel\'s line; behind an open question it says the text waits, and the card stays', async (t) => {
  const { ok, fake, store, session, tick } = setup(t);
  await ok(['create', 'design']);
  await ok(['start', 'design', '--cloud', '--repo', 'site', 'Fix the footer links']);
  fake.sessions = [session({ worker_status: 'requires_action', last_event_at: '2026-11-19T20:01:00Z', needs: 'Which page?' })];
  await tick();
  const out = await ok(['send', `cloud/${SID}`, 'The media kit.']);
  assert.equal(out, `Sent to cloud/${SID}. It has a question open: your text waits behind it until the question is answered on claude.ai.`);
  assert.deepEqual(fake.sent, [{ id: SID, text: "From the user via #design's chat: The media kit." }]);
  assert.equal(store().channels[0].inbox.length, 1, 'the question card stays');
  fake.sessions = [session({ worker_status: 'idle', last_event_at: '2026-11-19T20:05:00Z', summary: 'Done' })];
  await tick();
  assert.match(await ok(['send', SID, '--wake-on', 'finish', 'Now the header.']), /It takes this as its next message, in the cloud\. The chat is woken when it finishes\./);
  const s = store();
  assert.equal(s.channels[0].inbox.length, 0, 'a finish card has its answer');
  assert.equal(s.channels[0].tasks[0].wake.on, 'finish');
});

test('read, link, rename, dismiss and the card commands on a cloud task', async (t) => {
  const { ok, cli, fake, store, session, tick, opened } = setup(t);
  await ok(['create', 'design']);
  await ok(['start', 'design', '--cloud', '--repo', 'site', '--name', 'Fix the footer', 'Fix the footer links']);
  fake.sessions = [session({ worker_status: 'idle', last_event_at: '2026-11-19T20:05:00Z', summary: 'Opened PR #31', detail: 'PR open', cost_usd: 0.4123 })];
  await tick();
  const read = await ok(['read', `cloud/${SID}`]);
  assert.match(read, /^Fix the footer {2}cloud\/session_\S+\ndone: PR open {2}\(site\)\nOn claude\.ai: https:\/\/claude\.ai\/code\/session_\S+\nCost so far: \$0\.41\nIts last turn, as claude\.ai sums it up: Opened PR #31\nA cloud task's messages are on claude\.ai/);
  assert.equal(JSON.parse(await ok(['read', SID, '--json'])).summary.state, 'done');
  assert.equal((await ok(['link', `cse_${SFX}`])).trim(), URL_);
  await ok(['link', SID, '--open']);
  assert.deepEqual(opened, [URL_]);
  // Tell chat: the card's report, from the summary.
  const told = await ok(['card', 'tell', `cloud/${SID}`]);
  assert.match(told, /^\[task report\] #design · task "Fix the footer" \(cloud\/session_\S+\) finished\./);
  assert.match(told, /The user pressed Tell chat/);
  assert.match(told, /<task-report>\nOpened PR #31\n<\/task-report>/);
  assert.equal(store().channels[0].inbox.length, 0);
  // Rename: here only, said so; claude.ai's title no longer replaces it.
  assert.match(await ok(['rename-task', SID, 'Footer links']), /to "Footer links" here only: Claude Code has no supported way to rename a cloud session from outside/);
  fake.sessions = [session({ title: 'Something on claude.ai', worker_status: 'running', last_event_at: '2026-11-19T20:06:00Z' })];
  await tick();
  assert.equal(store().channels[0].tasks[0].name, 'Footer links');
  // Dismiss points to claude.ai for archiving.
  assert.match(await ok(['dismiss', SID]), /^Dismissed cloud\/session_\S+ from #design\. A cloud session keeps running and stays on claude\.ai: archive it there \(··· → Archive\), https:\/\/claude\.ai\/code\/session_/);
  assert.match((await cli(['read', 'cloud/session_x'])).err, /isn't a cloud session/);
});

test('a title changed on claude.ai becomes the task\'s name, unless it was renamed here', async (t) => {
  const { ok, fake, store, session, tick } = setup(t);
  await ok(['create', 'design']);
  await ok(['start', 'design', '--cloud', '--repo', 'site', 'Fix the footer links']);
  fake.sessions = [session({ title: 'Footer: links and spacing' })];
  await tick();
  assert.equal(store().channels[0].tasks[0].name, 'Footer: links and spacing');
});

test('list --json says whether claude --cloud attaches here, from the probe the listener runs now and then', async (t) => {
  const { ok, fake, dir, deps } = setup(t);
  await ok(['create', 'design']);
  await ok(['start', 'design', '--cloud', '--repo', 'site', 'Fix the footer links']);
  assert.equal(JSON.parse(await ok(['list', '--json'])).cloud.attach, false);
  assert.equal(await ch.probeAttachLater({ dir, deps }), 'off');
  assert.equal(fake.probes, 1);
  assert.equal(ch.probeAttachLater({ dir, deps }), null, 'not again within CLOUD.attachMs');
  writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'cloud.json'), 'utf8')), attach: { state: 'on', at: Date.now() } }));
  assert.equal(JSON.parse(await ok(['list', '--json'])).cloud.attach, true);
});

test('the chat is told about cloud tasks only when they are on', async () => {
  const was = process.env.CHANNELS_CLOUD;
  process.env.CHANNELS_CLOUD = '1';
  assert.match(ch.chatPrompt('/nonexistent', 'design'), /Cloud tasks are on for this Mac: `channels start design --cloud --repo <project>/);
  process.env.CHANNELS_CLOUD = '';
  assert.doesNotMatch(ch.chatPrompt('/nonexistent', 'design'), /--cloud/);
  process.env.CHANNELS_CLOUD = was ?? '';
});
