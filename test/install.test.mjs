// install.mjs into a fake home: the command it writes runs, the mod and layout are copied (renamed on a clash,
// never overwriting), config.js says where everything is, and the layout is selected for the next start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, cwd: home });
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
  assert.deepEqual(readdirSync(mod).sort(), ['.herdr-channels.json', 'config.js', 'emoji.js', 'icons', 'main.js', 'mod.json', 'needs.svg', 'viewer.py']);
  const config = loadConfig(join(mod, 'config.js'));
  assert.deepEqual({ ...config, path: typeof config.path }, { mod: 'channels', layout: 'channels', command: wrapper, path: 'string', projects: join(home, 'projects'), by: 'sam' });
  assert.ok(config.path.split(':').includes(join(home, '.local', 'bin')));
  assert.ok(existsSync(join(home, 'projects')));
  const layout = JSON.parse(readFileSync(join(appHome, 'layouts', 'channels.json'), 'utf8'));
  assert.equal(layout.id, 'root');
  assert.equal(JSON.parse(readFileSync(join(appHome, 'shared.json'), 'utf8')).layout, 'channels');
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
  assert.equal(layout.match(/"mod": "channels-3"/g).length, 4);
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
