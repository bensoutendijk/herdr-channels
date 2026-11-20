// install.mjs into a fake home: the command it writes runs, the mod and layout are copied (renamed on a clash,
// never overwriting), config.js says where everything is, and the layout is selected for the next start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneVersion } from '../bin/release.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, 'install.mjs');

function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'install-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const appHome = join(home, '.config', 'herdr-app');
  mkdirSync(join(appHome, 'mods'), { recursive: true });
  mkdirSync(join(appHome, 'layouts'), { recursive: true });
  const env = { ...process.env, HOME: home, HERDR_APP_HOME: '', PATH: `/usr/bin:/bin` };
  const install = (...args) => {
    // --no-timer: a test never loads a launchd agent. The timer is tested below with a stand-in for launchctl.
    const r = spawnSync(process.execPath, [script, '--no-timer', ...args], { encoding: 'utf8', env, cwd: home });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  };
  return { home, appHome, env, install };
}

const loadConfig = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^[\s\S]*?export default /, '').replace(/;\s*$/, ''));

test('a fresh install writes the command, copies the mod and layout, and selects the layout', (t) => {
  const { home, appHome, env, install } = setup(t);
  const out = install('--by', 'sam');
  assert.match(out, /Installed herdr-channels/);
  const wrapper = join(home, '.local', 'bin', 'channels');
  // The command runs from anywhere with the store it was installed with.
  const r = spawnSync(wrapper, ['create', 'design'], { encoding: 'utf8', env: { ...env, CHANNELS_MACHINE: 'testmac' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, '.local', 'state', 'herdr-channels', 'channels.json')));
  const listed = JSON.parse(spawnSync(wrapper, ['list', '--json'], { encoding: 'utf8', env: { ...env, CHANNELS_MACHINE: 'testmac' } }).stdout);
  assert.deepEqual([listed.machine, listed.channels.map((c) => c.name)], ['testmac', ['design']]);
  // The mod, without the files herdr writes itself, and its settings.
  const mod = join(appHome, 'mods', 'channels');
  assert.deepEqual(readdirSync(mod).sort(), ['.herdr-channels.json', 'backend.js', 'chats.js', 'config.js', 'emoji.js', 'icons', 'main.js', 'mod.json', 'needs.svg', 'panels.js', 'spaces.js', 'updates.js', 'viewer.py']);
  const config = loadConfig(join(mod, 'config.js'));
  assert.deepEqual({ ...config, path: typeof config.path }, { mod: 'channels', layout: 'channels', command: wrapper, path: 'string', projects: join(home, 'projects'), by: 'sam', version: cloneVersion() });
  assert.ok(config.path.split(':').includes(join(home, '.local', 'bin')));
  assert.ok(existsSync(join(home, 'projects')));
  const layout = JSON.parse(readFileSync(join(appHome, 'layouts', 'channels.json'), 'utf8'));
  assert.equal(layout.id, 'root');
  assert.equal(JSON.parse(readFileSync(join(appHome, 'shared.json'), 'utf8')).layout, 'channels');
  // The build the chats run is stamped, and the chats were refreshed (none runs here).
  const build = JSON.parse(readFileSync(join(home, '.local', 'state', 'herdr-channels', 'build.json'), 'utf8'));
  assert.match(build.id, /^[0-9a-f]{12}$/);
  assert.equal(listed.updates.build.id, build.id);
  assert.match(out, /chats {4}Every chat is up to date\./);
  // The version beside it, and the options an update installs with again (this install's, under the name it got).
  assert.equal(build.version, cloneVersion());
  assert.equal(listed.updates.release.current, cloneVersion());
  const store = join(home, '.local', 'state', 'herdr-channels');
  const recorded = JSON.parse(readFileSync(join(store, 'install.json'), 'utf8'));
  assert.deepEqual(recorded.args, ['--app-home', appHome, '--bin', join(home, '.local', 'bin'), '--chat-mod', join(home, '.local', 'share', 'herdr-channels', 'chat-mod'), '--store', store, '--projects', join(home, 'projects'), '--by', 'sam', '--name', 'channels', '--label', 'dev.herdr-channels.tick', '--no-timer']);
});

test('the build id changes with the code a chat runs and with the command\'s settings, not with the herdr mod', async () => {
  const { buildId } = await import('../install.mjs');
  const root = repo.replace(/\/$/, '');
  assert.equal(buildId(root, 'w1'), buildId(root, 'w1'));
  assert.notEqual(buildId(root, 'w1'), buildId(root, 'w2'), 'Remote Control or cloud turned on or off');
});

test('the task cards mod is copied for the chats, the command tells them where it is, and uninstall takes it out', (t) => {
  const { home, appHome, env, install } = setup(t);
  install();
  const chatMod = join(home, '.local', 'share', 'herdr-channels', 'chat-mod');
  assert.ok(existsSync(join(chatMod, '.claude-plugin', 'plugin.json')));
  assert.ok(existsSync(join(chatMod, 'hooks', 'register.tsx')));
  assert.ok(existsSync(join(chatMod, '.herdr-channels.json')));
  const wrapper = readFileSync(join(home, '.local', 'bin', 'channels'), 'utf8');
  assert.match(wrapper, new RegExp(`export CHANNELS_CHAT_MOD="\\$\\{CHANNELS_CHAT_MOD:-${chatMod}\\}"`));
  assert.match(wrapper, /export CHANNELS_HERDR_MOD="\$\{CHANNELS_HERDR_MOD:-channels\}"/);
  assert.match(wrapper, new RegExp(`export CHANNELS_HERDR_HOME="\\$\\{CHANNELS_HERDR_HOME:-${appHome}\\}"`));
  // A folder there that this install didn't make is left alone.
  const other = join(home, 'theirs');
  mkdirSync(other);
  const r = spawnSync(process.execPath, [script, '--no-timer', '--chat-mod', other], { encoding: 'utf8', env, cwd: home });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /isn't from this install; it's left alone/);
  const out = spawnSync(process.execPath, [script, '--uninstall', '--no-timer'], { encoding: 'utf8', env, cwd: home });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(existsSync(chatMod), false);
  assert.ok(existsSync(other));
});

test('a name already taken is never overwritten: the copy is renamed everywhere; installing again updates it in place', (t) => {
  const { appHome, install, home } = setup(t);
  mkdirSync(join(appHome, 'mods', 'channels'));
  writeFileSync(join(appHome, 'mods', 'channels', 'main.js'), '// someone else\'s');
  writeFileSync(join(appHome, 'layouts', 'channels-2.json'), '{"someone":"else"}');
  writeFileSync(join(appHome, 'shared.json'), JSON.stringify({ layout: 'main', other: 1 }));
  assert.match(install(), /"channels" was taken, so this is "channels-3"/);
  assert.equal(readFileSync(join(appHome, 'mods', 'channels', 'main.js'), 'utf8'), '// someone else\'s');
  assert.equal(readFileSync(join(appHome, 'layouts', 'channels-2.json'), 'utf8'), '{"someone":"else"}');
  const config = loadConfig(join(appHome, 'mods', 'channels-3', 'config.js'));
  assert.deepEqual([config.mod, config.layout], ['channels-3', 'channels-3']);
  const layout = readFileSync(join(appHome, 'layouts', 'channels-3.json'), 'utf8');
  assert.doesNotMatch(layout, /"mod": "channels"/);
  assert.equal(layout.match(/"mod": "channels-3"/g).length, 5);
  assert.deepEqual(JSON.parse(readFileSync(join(appHome, 'shared.json'), 'utf8')), { layout: 'channels-3', other: 1 }, 'the rest of shared.json stays');
  // Again: the same copy, updated; files herdr wrote into it stay.
  writeFileSync(join(appHome, 'mods', 'channels-3', 'jsconfig.json'), '{}');
  writeFileSync(join(appHome, 'mods', 'channels-3', 'stale.js'), '');
  assert.match(install('--no-switch'), /channels-3 \(updated\)/);
  assert.ok(existsSync(join(appHome, 'mods', 'channels-3', 'jsconfig.json')));
  assert.ok(!existsSync(join(appHome, 'mods', 'channels-3', 'stale.js')));
  assert.ok(!existsSync(join(appHome, 'mods', 'channels-4')));
  assert.ok(existsSync(join(home, '.local', 'bin', 'channels')));
});

test('Remote Control is off unless asked for; --remote-control turns it on, an install with neither option keeps it, --no-remote-control turns it off', (t) => {
  const { home, env, install } = setup(t);
  const wrapper = join(home, '.local', 'bin', 'channels');
  const listed = () => JSON.parse(spawnSync(wrapper, ['list', '--json'], { encoding: 'utf8', env: { ...env, CHANNELS_MACHINE: 'testmac' } }).stdout).remote_control;
  // Not a terminal: no question, and off.
  assert.match(install(), /remote {3}off \(--remote-control turns it on/);
  assert.equal(listed(), false);
  assert.doesNotMatch(readFileSync(wrapper, 'utf8'), /CHANNELS_REMOTE_CONTROL/);
  assert.match(install('--remote-control'), /remote {3}on: new tasks and chats show at claude\.ai\/code[\s\S]*Remote Control is now on[\s\S]*Running chats have restarted with it/);
  assert.equal(listed(), true);
  assert.match(readFileSync(wrapper, 'utf8'), /^export CHANNELS_REMOTE_CONTROL="\$\{CHANNELS_REMOTE_CONTROL:-1\}"$/m);
  const again = install();
  assert.match(again, /remote {3}on/, 'an update keeps it');
  assert.doesNotMatch(again, /Remote Control is now/);
  assert.match(install('--dry-run', '--no-remote-control'), /remote {3}off/);
  assert.equal(listed(), true, 'a dry run changes nothing');
  assert.match(install('--no-remote-control'), /Remote Control is now off/);
  assert.equal(listed(), false);
  // Claude Code's own settings are never written.
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
  assert.equal(existsSync(join(home, '.claude.json')), false);
});

test('a `channels` on PATH that this install didn\'t write is left alone', (t) => {
  const { home, env } = setup(t);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'channels'), '#!/bin/sh\necho mine\n');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't from this install; it's left alone/);
  assert.equal(readFileSync(join(home, '.local', 'bin', 'channels'), 'utf8'), '#!/bin/sh\necho mine\n');
});

test('the repo names no person, home folder or host of its own', () => {
  const files = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  // Spelled in pieces, so this file doesn't match itself.
  const words = [['bo', 'ris'], ['/home/', 'b', 'en'], ['/Users/', 'b', 'en'], ['\\bb', 'en\\b'], ['agent', '-os']].map((w) => new RegExp(w.join(''), 'i'));
  const hits = [];
  for (const f of files) {
    if (!existsSync(join(repo, f))) continue;
    let text = readFileSync(join(repo, f), 'utf8');
    // The license's copyright line names the author, on purpose.
    if (f === 'LICENSE') text = text.replace(/^Copyright \(c\) .*$/m, '');
    for (const w of words) if (w.test(text)) hits.push(`${f}: ${w}`);
  }
  assert.deepEqual(hits, []);
});

test('the routines timer: a launchd agent that runs `channels tick` every minute with this home; reinstalling reloads it', async (t) => {
  const { home } = setup(t);
  const { installTimer, plistPath, LABEL } = await import('../install.mjs');
  const calls = [];
  const run = (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const store = join(home, 'store');
  const r = installTimer({ label: 'dev.herdr-channels.test.abc', wrapper: join(home, 'bin', 'channels'), store, home, platform: 'darwin', run });
  assert.equal(r.plist, plistPath(home, 'dev.herdr-channels.test.abc'));
  assert.match(r.state, /loaded as dev.herdr-channels.test.abc/);
  const plist = readFileSync(r.plist, 'utf8');
  for (const s of ['<key>Label</key><string>dev.herdr-channels.test.abc</string>', `<string>${join(home, 'bin', 'channels')}</string><string>tick</string>`,
    '<key>StartInterval</key><integer>60</integer>', '<key>RunAtLoad</key><true/>', `<key>HOME</key><string>${home}</string>`, `<string>${join(store, 'launchd.log')}</string>`]) assert.ok(plist.includes(s), s);
  assert.deepEqual(calls.map((c) => c[0]), ['bootout', 'bootstrap']);
  assert.equal(calls[1][2], r.plist);
  assert.equal(LABEL, 'dev.herdr-channels.tick');
  // Not on macOS: nothing is written.
  assert.equal(installTimer({ label: 'x', wrapper: 'w', store, home, platform: 'linux', run }).plist, null);
});

test('--uninstall removes the timer, the command and this repo\'s mod and layout, and leaves everything else', async (t) => {
  const { home, appHome, install } = setup(t);
  const { installTimer, uninstall, parse, plistPath } = await import('../install.mjs');
  // Someone else's mod and layout, installed before: this repo's copy goes in as channels-2.
  mkdirSync(join(appHome, 'mods', 'channels'));
  writeFileSync(join(appHome, 'mods', 'channels', 'main.js'), '// someone else\'s');
  writeFileSync(join(appHome, 'layouts', 'channels.json'), '{}');
  install();
  const o = parse(['--label', 'dev.herdr-channels.test.abc'], { HERDR_APP_HOME: '' }, home);
  const calls = [];
  const run = (args) => { calls.push(args); return { status: 0 }; };
  installTimer({ label: o.label, wrapper: join(o.bin, 'channels'), store: o.store, home, platform: 'darwin', run });
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.someone.else.plist'), 'theirs');
  const gone = uninstall(o, { home, platform: 'darwin', run, log: () => {} });
  assert.deepEqual(calls.at(-1), ['bootout', `gui/${process.getuid()}/dev.herdr-channels.test.abc`]);
  assert.equal(existsSync(plistPath(home, o.label)), false);
  assert.equal(existsSync(join(home, '.local', 'bin', 'channels')), false);
  assert.equal(existsSync(join(appHome, 'mods', 'channels-2')), false);
  assert.equal(existsSync(join(appHome, 'layouts', 'channels-2.json')), false);
  assert.equal(existsSync(o.chatMod), false, "the chats' task cards mod");
  assert.equal(gone.length, 5);
  // Left alone: someone else's mod, layout and agent, and the store.
  assert.ok(existsSync(join(appHome, 'mods', 'channels', 'main.js')));
  assert.ok(existsSync(join(appHome, 'layouts', 'channels.json')));
  assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.someone.else.plist')));
});

test('cloud tasks are off unless asked for and never asked about; --cloud turns them on, an install with neither keeps it, --no-cloud turns them off', (t) => {
  const { home, env, install } = setup(t);
  const wrapper = join(home, '.local', 'bin', 'channels');
  const listed = () => JSON.parse(spawnSync(wrapper, ['list', '--json'], { encoding: 'utf8', env: { ...env, CHANNELS_MACHINE: 'testmac' } }).stdout).cloud.on;
  assert.match(install(), /cloud {4}off \(--cloud turns it on; see the README, "Cloud tasks"\)/);
  assert.equal(listed(), false);
  assert.doesNotMatch(readFileSync(wrapper, 'utf8'), /CHANNELS_CLOUD/);
  assert.match(install('--cloud'), /cloud {4}on: channels start --cloud runs tasks at claude\.ai\/code[\s\S]*Cloud tasks are now on here[\s\S]*Running chats have restarted and watch their cloud tasks[\s\S]*private API/);
  assert.equal(listed(), true);
  assert.match(readFileSync(wrapper, 'utf8'), /^export CHANNELS_CLOUD="\$\{CHANNELS_CLOUD:-1\}"$/m);
  const again = install();
  assert.match(again, /cloud {4}on/, 'an update keeps it');
  assert.doesNotMatch(again, /Cloud tasks are now/);
  assert.match(install('--dry-run', '--no-cloud'), /cloud {4}off/);
  assert.equal(listed(), true, 'a dry run changes nothing');
  assert.match(install('--no-cloud'), /Cloud tasks are now off/);
  assert.equal(listed(), false);
  // Independent of Remote Control, and Claude Code's own settings are never written.
  assert.match(install('--cloud'), /remote {3}off/);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
  assert.equal(existsSync(join(home, '.claude.json')), false);
});

test('a store on another machine: only the mod and its layout, beside a channels mod this repo didn\'t install', (t) => {
  const { home, appHome, env, install } = setup(t);
  // Another channels mod already has the name: it is never touched.
  mkdirSync(join(appHome, 'mods', 'channels'));
  writeFileSync(join(appHome, 'mods', 'channels', 'main.js'), '// theirs\n');
  writeFileSync(join(appHome, 'layouts', 'channels.json'), '{"theirs":1}\n');
  const args = ['--on', 'server', '--command', 'hub channels', '--local', 'laptop', '--projects', '/srv/projects', '--by', 'me', '--name', 'channels-hc', '--no-switch'];
  assert.match(install(...args), /for the store on server/);
  assert.equal(readFileSync(join(appHome, 'mods', 'channels', 'main.js'), 'utf8'), '// theirs\n');
  assert.equal(readFileSync(join(appHome, 'layouts', 'channels.json'), 'utf8'), '{"theirs":1}\n');
  const mod = join(appHome, 'mods', 'channels-hc');
  const config = loadConfig(join(mod, 'config.js'));
  assert.deepEqual({ ...config, path: typeof config.path }, { mod: 'channels-hc', layout: 'channels-hc', command: ['hub', 'channels'], on: 'server', local: 'laptop', path: 'string', projects: '/srv/projects', by: 'me', version: cloneVersion() });
  const layout = readFileSync(join(appHome, 'layouts', 'channels-hc.json'), 'utf8');
  assert.ok(layout.includes('"mod": "channels-hc"') && !layout.includes('"mod": "channels"'));
  // No command, cards mod or store here, and the layout isn't selected.
  assert.equal(existsSync(join(home, '.local', 'bin', 'channels')), false);
  assert.equal(existsSync(join(home, '.local', 'share', 'herdr-channels')), false);
  assert.equal(existsSync(join(home, '.local', 'state', 'herdr-channels')), false);
  assert.equal(existsSync(join(appHome, 'shared.json')), false);
  // Again: updated in place. The name can't take theirs.
  assert.match(install(...args), /\(updated\)/);
  const r = spawnSync(process.execPath, [script, ...args.slice(0, -3), '--name', 'channels'], { encoding: 'utf8', env, cwd: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /channels is taken/);
  // Uninstall takes out this repo's copy only.
  const u = spawnSync(process.execPath, [script, '--uninstall'], { encoding: 'utf8', env, cwd: home });
  assert.equal(u.status, 0, u.stderr);
  assert.equal(existsSync(mod), false);
  assert.equal(readFileSync(join(appHome, 'mods', 'channels', 'main.js'), 'utf8'), '// theirs\n');
});

test('a store on another machine needs its command, this computer\'s name in it and its projects folder', async () => {
  const { parse } = await import('../install.mjs');
  const base = ['--on', 'server', '--command', 'hub channels', '--local', 'laptop', '--projects', '/srv/projects'];
  assert.deepEqual(parse(base, {}, '/h').command, ['hub', 'channels']);
  assert.equal(parse(base, {}, '/h').projects, '/srv/projects');
  assert.throws(() => parse(['--on', 'server', '--local', 'laptop', '--projects', '/p'], {}, '/h'), /needs --command/);
  assert.throws(() => parse(['--on', 'server', '--command', 'x', '--projects', '/p'], {}, '/h'), /needs --local/);
  assert.throws(() => parse(['--on', 'server', '--command', 'x', '--local', 'l'], {}, '/h'), /needs --projects/);
  assert.throws(() => parse(['--on', 'server', '--command', 'x', '--local', 'l', '--projects', 'rel'], {}, '/h'), /needs --projects/);
  assert.throws(() => parse(['--command', 'x'], {}, '/h'), /give --on too/);
  assert.throws(() => parse([...base, '--name', 'Bad Name'], {}, '/h'), /--name/);
  // Without --on, nothing changes: the projects folder is this computer's.
  assert.equal(parse(['--projects', '~/p'], {}, '/h').projects, '/h/p');
  assert.equal(parse([], {}, '/h').on, null);
});
