#!/usr/bin/env node
// Installs herdr-channels on this Mac, from this clone:
//   node install.mjs [--app-home <dir>] [--bin <dir>] [--store <dir>] [--projects <dir>] [--by <who>] [--no-switch] [--dry-run]
//
// 1. Writes `channels` into --bin (default ~/.local/bin): a small sh script that runs bin/channels.mjs in this
//    clone with the node running this install, with the store and projects folder it was given. Keep the clone
//    where it is; `git pull` updates the command.
// 2. Copies mods/channels and layouts/channels.json into the herdr app's folder (--app-home, else
//    $HERDR_APP_HOME, else ~/.config/herdr-app). A name already taken by something else is never overwritten:
//    the copy gets the next free name (channels-2, ...), in the folder, the layout and the mod's config.js. An
//    earlier install of this repo (marked by .herdr-channels.json in the mod folder) is updated in place.
// 3. Writes the mod's config.js: the command, the folders for PATH, the projects folder and the --by name.
// 4. Selects the layout: through the running herdr window, or, when none runs, for its next start.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const MARK = '# herdr-channels: written by install.mjs';
const MOD_MARK = '.herdr-channels.json';
// What herdr writes into a mod folder itself: never copied, and left alone in an installed copy.
const GENERATED = new Set(['gpui-kit.d.ts', 'jsconfig.json', MOD_MARK, 'config.js']);

const usage = 'usage: node install.mjs [--app-home <dir>] [--bin <dir>] [--store <dir>] [--projects <dir>] [--by <who>] [--no-switch] [--dry-run]';

export function parse(argv, env = process.env, home = homedir()) {
  const o = { appHome: env.HERDR_APP_HOME || join(home, '.config', 'herdr-app'), bin: join(home, '.local', 'bin'), store: join(home, '.local', 'state', 'herdr-channels'), projects: join(home, 'projects'), by: 'user', switch: true, dryRun: false };
  const valued = { '--app-home': 'appHome', '--bin': 'bin', '--store': 'store', '--projects': 'projects', '--by': 'by' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-switch') o.switch = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (valued[a]) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.\n${usage}`);
      o[valued[a]] = argv[++i];
    } else throw new Error(`Unknown option ${a}.\n${usage}`);
  }
  const expand = (p) => resolve(p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
  for (const k of ['appHome', 'bin', 'store', 'projects']) o[k] = expand(o[k]);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(o.by)) throw new Error('--by is one short lowercase word, such as your first name.');
  return o;
}

const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

// A program's path: on PATH, or where its installer usually puts it.
export function findProgram(name, { env = process.env, home = homedir() } = {}) {
  const dirs = [...`${env.PATH ?? ''}`.split(delimiter), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.claude', 'local'), '/usr/bin'];
  for (const d of dirs) if (d && executable(join(d, name))) return join(d, name);
  return null;
}

const sq = (s) => `'${`${s}`.replace(/'/g, `'\\''`)}'`;

export function wrapperText({ node, script, store, projects, path }) {
  return [
    '#!/bin/sh',
    MARK,
    `# Runs ${script}. Install again to change what it says.`,
    `export PATH=${sq(path)}:"$PATH"`,
    `export CHANNELS_DIR="\${CHANNELS_DIR:-${store.replace(/["\\$`]/g, '\\$&')}}"`,
    `export CHANNELS_PROJECTS="\${CHANNELS_PROJECTS:-${projects.replace(/["\\$`]/g, '\\$&')}}"`,
    'export CHANNELS_BIN="$0"',
    `exec ${sq(node)} ${sq(script)} "$@"`,
    '',
  ].join('\n');
}

export function configText(c) {
  return `// Written by herdr-channels' install.mjs. Install again to change it.\nexport default ${JSON.stringify(c, null, 2)};\n`;
}

// The mod folder and layout name to install as: "channels", or the next free name when "channels" is taken by
// something this repo didn't install.
export function pickNames(appHome) {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? 'channels' : `channels-${n}`;
    const modDir = join(appHome, 'mods', name);
    const layoutFile = join(appHome, 'layouts', `${name}.json`);
    let mine = null;
    try { mine = JSON.parse(readFileSync(join(modDir, MOD_MARK), 'utf8')); } catch { /* not ours */ }
    const modFree = !existsSync(modDir) || Boolean(mine);
    const layoutFree = !existsSync(layoutFile) || mine?.layout === name;
    if (modFree && layoutFree) return { name, update: Boolean(mine) };
  }
  throw new Error(`No free name for the mod in ${appHome}/mods.`);
}

function copyMod(from, to) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(to)) if (!GENERATED.has(f)) rmSync(join(to, f), { recursive: true, force: true });
  for (const f of readdirSync(from)) if (!GENERATED.has(f)) cpSync(join(from, f), join(to, f), { recursive: true });
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function herdrApp(home) {
  return findProgram('herdr-app', { home }) ?? (executable('/Applications/Herdr.app/Contents/MacOS/Herdr') ? '/Applications/Herdr.app/Contents/MacOS/Herdr'
    : executable(join(home, 'Applications', 'Herdr.app', 'Contents', 'MacOS', 'Herdr')) ? join(home, 'Applications', 'Herdr.app', 'Contents', 'MacOS', 'Herdr') : null);
}

// Shows the layout now when a herdr window for this app folder is open; else makes it the one the next start shows.
function selectLayout(appHome, layout, home) {
  const app = herdrApp(home);
  const env = { ...process.env, HERDR_APP_HOME: appHome };
  if (app && existsSync(join(appHome, 'herdr-app.sock'))) {
    const r = spawnSync(app, ['do', 'layout.switch', '--name', layout], { env, encoding: 'utf8', timeout: 20_000 });
    if (r.status === 0) return 'shown in the open herdr window';
  }
  const file = join(appHome, 'shared.json');
  let shared = {};
  try { shared = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  shared.layout = layout;
  writeAtomic(file, `${JSON.stringify(shared)}\n`);
  return 'set for the next herdr start';
}

export function install(o, { home = homedir(), env = process.env, log = console.log } = {}) {
  // The node on PATH when it is this one (Homebrew's /opt/homebrew/bin/node outlives an upgrade; the folder it
  // points into doesn't), else this one.
  const onPath = findProgram('node', { env, home });
  const node = onPath && realpathSync(onPath) === realpathSync(process.execPath) ? onPath : process.execPath;
  const script = join(REPO, 'bin', 'channels.mjs');
  const found = Object.fromEntries(['claude', 'hc', 'python3'].map((p) => [p, findProgram(p, { env, home })]));
  const SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const pathDirs = [...new Set([o.bin, dirname(node), ...Object.values(found).filter(Boolean).map((p) => dirname(p)), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])].filter((d) => !SYSTEM.includes(d));
  const path = pathDirs.join(':');

  // 1. The command.
  const wrapper = join(o.bin, 'channels');
  if (existsSync(wrapper) && !readFileSync(wrapper, 'utf8').includes(MARK)) {
    throw new Error(`${wrapper} exists and isn't from this install; it's left alone. Pass --bin <another folder on PATH>.`);
  }
  // 2. The mod and layout.
  if (!existsSync(o.appHome)) log(`${o.appHome} doesn't exist yet; it is made now. Open the herdr app once to fill it in.`);
  const { name, update } = pickNames(o.appHome);
  const modDir = join(o.appHome, 'mods', name);
  const layoutFile = join(o.appHome, 'layouts', `${name}.json`);
  const layout = JSON.parse(readFileSync(join(REPO, 'layouts', 'channels.json'), 'utf8'));
  const rename = (n) => { if (n?.content?.mod === 'channels') n.content.mod = name; for (const c of n?.children ?? []) rename(c); };
  rename(layout);
  const config = { mod: name, layout: name, command: wrapper, path, projects: o.projects, by: o.by };

  if (o.dryRun) return { wrapper, modDir, layoutFile, name, update, config, found, selected: null };

  mkdirSync(o.bin, { recursive: true });
  writeAtomic(wrapper, wrapperText({ node, script, store: o.store, projects: o.projects, path }));
  spawnSync('chmod', ['755', wrapper]);
  copyMod(join(REPO, 'mods', 'channels'), modDir);
  writeAtomic(join(modDir, 'config.js'), configText(config));
  writeAtomic(join(modDir, MOD_MARK), `${JSON.stringify({ repo: REPO, layout: name, at: new Date().toISOString() }, null, 2)}\n`);
  mkdirSync(dirname(layoutFile), { recursive: true });
  writeAtomic(layoutFile, `${JSON.stringify(layout, null, 2)}\n`);
  mkdirSync(o.projects, { recursive: true });
  const selected = o.switch ? selectLayout(o.appHome, name, home) : 'not selected (--no-switch)';
  return { wrapper, modDir, layoutFile, name, update, config, found, selected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parse(process.argv.slice(2));
    const r = install(o);
    const missing = Object.entries(r.found).filter(([, p]) => !p).map(([n]) => n);
    console.log(`${o.dryRun ? 'Would install' : 'Installed'} herdr-channels from ${REPO}:`);
    console.log(`  command  ${r.wrapper}`);
    console.log(`  mod      ${r.modDir}${r.update ? ' (updated)' : ''}`);
    console.log(`  layout   ${r.layoutFile}${r.name !== 'channels' ? `  ("channels" was taken, so this is "${r.name}")` : ''}`);
    console.log(`  store    ${o.store}`);
    console.log(`  projects ${o.projects}`);
    if (r.selected) console.log(`  The ${r.name} layout is ${r.selected}.`);
    if (missing.length) console.log(`\nNot found: ${missing.join(', ')}. Install ${missing.includes('hc') ? 'the herdr app (it brings hc), ' : ''}${missing.filter((m) => m !== 'hc').join(' and ') || ''} and run this again.`);
    if (!`${process.env.PATH}`.split(delimiter).includes(o.bin)) console.log(`\n${o.bin} isn't on your PATH. Add it to use \`channels\` in a terminal; the mod and chats find it without that.`);
    console.log(`\nClaude Code starts background sessions only in a folder you trust: run \`claude\` once in ${o.projects} and accept, if you haven't.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
