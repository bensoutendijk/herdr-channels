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
  assert.deepEqual(B.featuresOf({ machine: 'x', remote_control: false, channels: [] }), B.ALL_FEATURES);
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
