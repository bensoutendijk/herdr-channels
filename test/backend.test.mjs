// Where the mod's store lives and what its command can do (mods/channels/backend.js): this repo's `channels` on
// this computer by default, or another command on another machine (`hub channels` on a home server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as B from '../mods/channels/backend.js';
import CONFIG from '../mods/channels/config.js';
import { FEATURES } from '../bin/channels.mjs';

const HOME = '/Users/someone';
const HERE = B.backendOf(CONFIG, HOME); // config.js as it ships: this repo's command, on this computer
const HUB = B.backendOf({ command: ['hub', 'channels'], on: 'server', local: 'mac', by: 'me', projects: '/home/someone/projects' }, HOME);

test('the defaults are the store on this computer, as before', () => {
  assert.deepEqual(HERE, { command: ['channels'], on: null, local: null, by: 'user', projects: `${HOME}/projects`, localProjects: `${HOME}/projects` });
  // An install writes an absolute path, one program even with a space in it.
  assert.deepEqual(B.backendOf({ command: '/Users/a b/.local/bin/channels', projects: '/p' }, HOME).command, ['/Users/a b/.local/bin/channels']);
  assert.equal(B.backendOf({ projects: '/p' }, HOME).localProjects, '/p');
  assert.deepEqual(HUB, { command: ['hub', 'channels'], on: 'server', local: 'mac', by: 'me', projects: '/home/someone/projects', localProjects: HOME });
});

test("the shell line runs the store's command, quoted, and finds programs in that machine's ~/.local/bin", () => {
  const run = (backend, script, ...args) => spawnSync('sh', ['-c', `${B.shellPrelude(backend)}${script}`, '/nowhere', ...args], { encoding: 'utf8' }).stdout;
  // A command with fixed words, and args that would break unquoted.
  const echo = B.backendOf({ command: ['printf', '%s|'] }, HOME);
  assert.equal(run(echo, 'channels "$1" "$2"', "it's", 'a b; rm -rf /'), "it's|a b; rm -rf /|");
  assert.match(B.shellPrelude(HUB), /^PATH="\$HOME\/\.local\/bin:\$0:\$PATH"; channels\(\) \{ 'hub' 'channels' "\$@"; \}; $/);
  assert.match(B.shellPrelude(HERE), /^PATH="\$0:\$PATH"; channels\(\) \{ 'channels' "\$@"; \}; $/);
});

test("a store on another machine never names this computer: its `machine` is its own", () => {
  const data = { machine: 'server' }; // what the hub's list --json says
  assert.equal(B.localName(HUB, data), 'mac');
  assert.equal(B.localName({ ...HUB, local: null }, data), null, 'not server: that would open its tasks on this Mac');
  assert.equal(B.localName(HERE, { machine: 'studio' }), 'studio');
  assert.equal(B.localName(HERE, null), null);
});

test('a task opens on the machine it runs on, or nowhere when Herdr can\'t reach it', () => {
  const data = { machine: 'server' };
  const known = ['server', 'desktop'];
  const where = (machine, backend = HUB, d = data) => B.herdrMachine({ machine }, { backend, data: d, known });
  assert.equal(where('mac'), null, 'this computer');
  assert.equal(where('server'), 'server', 'the store\'s machine');
  assert.equal(where('desktop'), 'desktop', 'another machine Herdr knows');
  assert.equal(where('laptop'), undefined, 'one it doesn\'t');
  assert.equal(where('cloud'), null, 'a cloud task opens here');
  // The store's machine is reached through `on` even when the store calls it something else.
  assert.equal(B.herdrMachine({ machine: 'srv' }, { backend: { ...HUB, on: 'server' }, data: { machine: 'srv' }, known: [] }), 'server');
  // This repo's store on this computer: its own tasks only, as before.
  assert.equal(where('studio', HERE, { machine: 'studio' }), null);
  assert.equal(where('server', HERE, { machine: 'studio' }), undefined);
});

test('features: what list --json says, else this repo\'s older command had them all, else none', () => {
  assert.deepEqual(FEATURES, B.ALL_FEATURES, 'the command and the mod agree');
  assert.deepEqual(B.featuresOf({ machine: 'x', features: ['seen', 7] }), ['seen']);
  assert.deepEqual(B.featuresOf({ machine: 'x', remote_control: false, channels: [] }), B.ALL_FEATURES.filter((f) => !['update', 'routine-edit-on', 'routine-manual', 'routine-dry-run', 'routine-status', 'routine-by', 'harnesses', 'refresh-all'].includes(f)), 'a command from before the list: only what it had then');
  assert.deepEqual(B.featuresOf({ machine: 'server', channels: [] }), [], 'a hub that lists none');
  assert.deepEqual(B.featuresOf(null), []);
});

test('standing comes from the list of the machine a task runs on', () => {
  const server = B.agentIndex(JSON.stringify([{ sessionId: 's1', state: 'working' }, { id: 'j2', status: 'waiting' }]));
  const mac = B.agentIndex([{ sessionId: 's3', state: 'blocked' }]);
  const idx = { server, mac };
  assert.equal(B.agentOf({ machine: 'server', session_id: 's1' }, idx)?.state, 'working');
  assert.equal(B.agentOf({ machine: 'server', session_id: 'x', job: 'j2' }, idx)?.status, 'waiting');
  assert.equal(B.agentOf({ machine: 'mac', session_id: 's3' }, idx)?.state, 'blocked');
  assert.equal(B.agentOf({ machine: 'mac', session_id: 's1' }, idx), null, 'a session id on another machine is not this one');
  assert.equal(B.agentOf({ machine: 'desktop', session_id: 's1' }, idx), null, 'a third machine has no list');
  // A store on this computer: one list, whatever the task's machine is called.
  assert.equal(B.agentOf({ machine: 'old-name', session_id: 's1' }, {}, server)?.state, 'working');
  assert.equal(B.agentIndex('not json').size, 0);
});

test("the footer says whether Herdr reaches the store's machine", () => {
  assert.equal(B.linkState(HERE, []), 'here');
  assert.equal(B.linkState(HUB, [{ name: 'server', layout: 'ready' }]), 'connected');
  assert.equal(B.linkState(HUB, [{ name: 'server', layout: 'loading' }]), 'connecting');
  assert.equal(B.linkState(HUB, [{ name: 'server', layout: 'unavailable' }]), 'unreachable');
  assert.equal(B.linkState(HUB, []), 'unreachable');
  assert.equal(B.linkState(HUB, [{ name: 'server', layout: 'ready' }], 'boom'), 'unreadable');
});

test('a copy installed beside another keeps its own shared state', () => {
  assert.equal(B.keyOf('channels', 'data'), 'channels.data', 'the default copy: the keys it always had');
  assert.equal(B.keyOf('channels-hc', 'data'), 'channels-hc.data');
  assert.equal(B.keyOf('', 'data'), 'channels.data');
});

test('capabilities --json is preferred: what it lists, or null for a command that doesn\'t know the question', () => {
  const r = spawnSync(process.execPath, [new URL('../bin/channels.mjs', import.meta.url).pathname, 'capabilities', '--json'], { encoding: 'utf8', env: { ...process.env, CHANNELS_DIR: '/nonexistent-store' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(B.capabilitiesOf(r.stdout), B.ALL_FEATURES, 'this repo\'s command lists them all');
  assert.deepEqual(B.capabilitiesOf('{"features":["chat-bg","seen",3,"refresh"]}\n'), ['chat-bg', 'seen', 'refresh']);
  assert.equal(B.capabilitiesOf('usage: hub channels [list …]'), null, 'an older command answers with its usage');
  assert.equal(B.capabilitiesOf(''), null);
  assert.equal(B.capabilitiesOf('{"machine":"server"}'), null);
});

test("a store on another machine's terminal addresses are named by that machine here", () => {
  assert.equal(B.remoteAddress('t2k', 'server'), 'server/t2k');
  assert.equal(B.remoteAddress('server/t2k', 'server'), 'server/t2k');
  assert.equal(B.remoteAddress('t2k', null), 't2k', 'a store on this computer: as it is');
  assert.equal(B.remoteAddress(null, 'server'), null);
});

test('a task\'s standing: Claude Code\'s list on its machine first, then the store\'s own (a hub reads every machine), then ready', () => {
  assert.equal(B.standingOf('working', 'needs'), 'working');
  assert.equal(B.standingOf(null, 'needs'), 'needs', 'a task on a third machine: the store says');
  assert.equal(B.standingOf(null, undefined), 'ready', "this repo's store gives none");
  assert.equal(B.standingOf(null, 'done'), 'ready', 'only the three standings are taken');
});

test('the Routines dialog names whose clock a routine keeps: this Mac\'s, or the store machine\'s', () => {
  assert.deepEqual(B.routineClock(null), { times: "Times are this Mac's local time.", short: "Times are this Mac's.", missed: 'If the Mac was asleep, still run it within' });
  assert.deepEqual(B.routineClock('server'), { times: "Times are server's local time.", short: "Times are server's.", missed: 'If server was off, still run it within' });
});

test('the Routines dialog names the zone and says the catch-up window as an outcome', () => {
  assert.equal(B.clockOf('{"features":[],"clock":{"tz":"Europe/Amsterdam"}}\n'), 'Europe/Amsterdam');
  assert.equal(B.clockOf('{"features":[]}'), null, 'an older command says no zone');
  assert.equal(B.clockOf('usage: …'), null);
  assert.equal(B.routineClock(null, 'Europe/Amsterdam').short, "Times are this Mac's (Europe/Amsterdam).");
  assert.equal(B.routineClock('server', 'Europe/Amsterdam').times, "Times are server's local time (Europe/Amsterdam).");
  assert.equal(B.catchupRule(null, '09:00', '10:00'), "If the Mac sleeps through 09:00, it runs on wake until 10:00, else it's skipped.");
  assert.equal(B.catchupRule(null, '09:00', null), 'If the Mac sleeps through 09:00, that run is skipped.');
  assert.equal(B.catchupRule('server', '09:00', '13:00'), "If server is off at 09:00, it runs when server is back until 13:00, else it's skipped.");
  assert.equal(B.catchupRule(null, null, '10:00'), '');
});

test('the sidebar clock is tinted by the routines\' status: missed or broken first, then a run stuck waiting', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  const r = (name, state, extra = {}) => ({ name, enabled: true, status: { state, words: `${name} ${state}`, at: '2026-11-23T09:55:00Z' }, ...extra });
  assert.equal(B.routineTint([r('a', 'ok'), r('b', 'never')], now), null);
  assert.equal(B.routineTint([r('a', 'waiting')], now), null, 'a run queued minutes ago is not stuck');
  assert.equal(B.routineTint([r('a', 'waiting', { last: { waiting: { why: 'x' } } })], now).tint, 'working', 'it says why it waits');
  assert.equal(B.routineTint([r('a', 'waiting', { status: { state: 'waiting', words: 'w', at: '2026-11-23T09:40:00Z' } })], now).tint, 'working', 'over 10 minutes');
  assert.deepEqual(B.routineTint([r('a', 'waiting', { last: { waiting: { why: 'x' } } }), r('b', 'missed')], now).routine.name, 'b');
  assert.equal(B.routineTint([r('a', 'missed', { enabled: false })], now), null, 'an off routine needs no look');
  assert.equal(B.routineTint([{ name: 'old', enabled: true, last: { status: 'missed' } }], now), null, 'an older backend gives no status');
});

test('waitingOf: what a channel row marks; an aged-out question, a dismissed task or an archived channel count for nothing', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600000).toISOString();
  const task = (o) => ({ dismissed: false, standing: 'ready', unread: null, asking: null, ...o });
  const c = {
    tasks: [
      task({ standing: 'needs', asking: { state: 'question', at: ago(1) }, unread: { kind: 'needs', at: ago(1) } }),
      task({ standing: 'needs', asking: { state: 'prompt', at: ago(72) } }), // a live prompt waits as long as it does
      task({ standing: 'needs', asking: { state: 'question', at: ago(72) } }), // its card aged out
      task({ standing: 'ready', unread: { kind: 'done', at: ago(1) } }),
      task({ standing: 'working' }),
      task({ standing: 'needs', dismissed: true }),
    ],
  };
  assert.deepEqual(B.waitingOf(c, { now, seen: true }), { needs: 2, unread: 1, held: 0 });
  // A store without `seen` never clears the unread mark: only what needs you counts.
  assert.deepEqual(B.waitingOf(c, { now, seen: false }), { needs: 2, unread: 0, held: 0 });
  assert.deepEqual(B.waitingOf({ ...c, archived_at: ago(1) }, { now, seen: true }), { needs: 0, unread: 0, held: 0 });
  assert.deepEqual(B.waitingOf(null), { needs: 0, unread: 0, held: 0 });
});

test('waitingOf: a store that doesn\'t give `asking` (an older one, or agent-os) has its waiting tasks counted', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const old = new Date(now - 72 * 3600000).toISOString();
  // No asking and no unread: nothing says how old, so it counts.
  assert.equal(B.waitingOf({ tasks: [{ standing: 'needs' }] }, { now }).needs, 1);
  // No asking, but an unread mark from when it asked: that says how old.
  assert.equal(B.waitingOf({ tasks: [{ standing: 'needs', unread: { kind: 'needs', at: old } }] }, { now }).needs, 0);
  assert.equal(B.QUESTION_TTL_MS, 2 * 86_400_000);
});

test('the Routines dialog says when the timer stopped, with the backend\'s command to start it again', () => {
  const now = Date.parse('2026-11-23T10:46:00Z');
  assert.equal(B.staleTimer({ last_tick_at: '2026-11-23T10:43:00Z' }, now), null);
  assert.equal(B.staleTimer({ last_tick_at: null }, now), null, 'never ticked: nothing to compare');
  assert.equal(B.staleTimer(null, now), null, 'an older backend says nothing');
  assert.deepEqual(B.staleTimer({ last_tick_at: '2026-11-23T10:40:00Z', hint: 'start it' }, now, () => '10:40'), { text: "The routines timer hasn't run since 10:40, so routines won't come due.", hint: 'start it' });
});
