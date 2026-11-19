#!/usr/bin/env node
// Installs herdr-channels on this Mac, from this clone:
//   node install.mjs [--app-home <dir>] [--bin <dir>] [--store <dir>] [--projects <dir>] [--by <who>] [--label <label>] [--no-timer] [--no-switch] [--dry-run]
//   node install.mjs --uninstall [--app-home <dir>] [--bin <dir>] [--label <label>]
//
// 1. Writes `channels` into --bin (default ~/.local/bin): a small sh script that runs bin/channels.mjs in this
//    clone with the node running this install, with the store and projects folder it was given. Keep the clone
//    where it is; `git pull` updates the command.
// 2. Copies mods/channels and layouts/channels.json into the herdr app's folder (--app-home, else
//    $HERDR_APP_HOME, else ~/.config/herdr-app). A name already taken by something else is never overwritten:
//    the copy gets the next free name (channels-2, ...), in the folder, the layout and the mod's config.js. An
//    earlier install of this repo (marked by .herdr-channels.json in the mod folder) is updated in place.
// 3. Writes the mod's config.js: the command, the folders for PATH, the projects folder and the --by name.
// 3b. Copies mods/claude, the task cards mod a channel's chat loads (`claude --plugin-dir`), to --chat-mod (default
//    ~/.local/share/herdr-channels/chat-mod). Only the chats load it: not tasks, nor your other Claude Code sessions.
// 4. Selects the layout: through the running herdr window, or, when none runs, for its next start.
// 5. Adds the routines timer: a launchd user agent (~/Library/LaunchAgents/<label>.plist, label
//    dev.herdr-channels.tick unless --label says otherwise) that runs `channels tick` every minute and once when the
//    Mac wakes. --no-timer leaves it out; it is macOS only.
// --uninstall takes out what an install put in: the timer, the command and the mod and layout this repo installed
// (a mod folder marked with .herdr-channels.json, and its layout). It never touches anything it didn't install, nor
// the channel store or any Claude Code session.
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

const usage = 'usage: node install.mjs [--app-home <dir>] [--bin <dir>] [--chat-mod <dir>] [--store <dir>] [--projects <dir>] [--by <who>] [--label <label>] [--no-timer] [--no-switch] [--dry-run]\n       node install.mjs --uninstall [--app-home <dir>] [--bin <dir>] [--chat-mod <dir>] [--label <label>]';
export const LABEL = 'dev.herdr-channels.tick';

export function parse(argv, env = process.env, home = homedir()) {
  const o = { appHome: env.HERDR_APP_HOME || join(home, '.config', 'herdr-app'), bin: join(home, '.local', 'bin'), chatMod: join(home, '.local', 'share', 'herdr-channels', 'chat-mod'), store: join(home, '.local', 'state', 'herdr-channels'), projects: join(home, 'projects'), by: 'user', switch: true, dryRun: false, timer: true, uninstall: false, label: LABEL };
  const valued = { '--app-home': 'appHome', '--bin': 'bin', '--chat-mod': 'chatMod', '--store': 'store', '--projects': 'projects', '--by': 'by', '--label': 'label' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-switch') o.switch = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-timer') o.timer = false;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (valued[a]) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.\n${usage}`);
      o[valued[a]] = argv[++i];
    } else throw new Error(`Unknown option ${a}.\n${usage}`);
  }
  const expand = (p) => resolve(p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
  for (const k of ['appHome', 'bin', 'store', 'projects', 'chatMod']) o[k] = expand(o[k]);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(o.by)) throw new Error('--by is one short lowercase word, such as your first name.');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(o.label)) throw new Error('--label is a launchd label: letters, digits, dots and dashes, e.g. dev.herdr-channels.tick.');
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

export function wrapperText({ node, script, store, projects, path, chatMod = null, mod = null, appHome = null, app = null }) {
  const keep = (name, value) => (value ? [`export ${name}="\${${name}:-${`${value}`.replace(/["\\$`]/g, '\\$&')}}"`] : []);
  return [
    '#!/bin/sh',
    MARK,
    `# Runs ${script}. Install again to change what it says.`,
    `export PATH=${sq(path)}:"$PATH"`,
    `export CHANNELS_DIR="\${CHANNELS_DIR:-${store.replace(/["\\$`]/g, '\\$&')}}"`,
    `export CHANNELS_PROJECTS="\${CHANNELS_PROJECTS:-${projects.replace(/["\\$`]/g, '\\$&')}}"`,
    'export CHANNELS_BIN="$0"',
    // What the chats' task cards need: the mod they load, and how to reach the herdr window (a card's Open).
    ...keep('CHANNELS_CHAT_MOD', chatMod),
    ...keep('CHANNELS_HERDR_MOD', mod),
    ...keep('CHANNELS_HERDR_HOME', appHome),
    ...keep('CHANNELS_HERDR_APP', app),
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

// The chat's task cards mod: a copy, marked as this install's, without what Claude Code writes into a plugin
// folder it loads (.claude-plugin/types).
function copyChatMod(from, to) {
  if (existsSync(to) && !existsSync(join(to, MOD_MARK))) throw new Error(`${to} exists and isn't from this install; it's left alone. Pass --chat-mod <another folder>.`);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (f) => !f.startsWith(join(from, '.claude-plugin', 'types')) });
  writeAtomic(join(to, MOD_MARK), `${JSON.stringify({ repo: REPO, at: new Date().toISOString() }, null, 2)}\n`);
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

// ---------- the routines timer ----------

const xml = (t) => `${t}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The launchd agent: `channels tick` every 60 seconds, and at load. launchd runs a timer missed while the Mac slept
// once when it wakes, which is when missed routines are caught up. HOME is set so the tick finds the same home
// (Claude Code's records, herdr-core) as the install did.
export function plistText({ label, wrapper, home, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by herdr-channels' install.mjs: runs the channels routines. \`node install.mjs --uninstall\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(wrapper)}</string><string>tick</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${xml(home)}</string></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export const plistPath = (home, label) => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const launchctl = (args) => spawnSync('launchctl', args, { encoding: 'utf8', timeout: 20_000 });

// Writes the agent's plist and (re)loads it. Answers what happened, for the summary.
export function installTimer({ label, wrapper, store, home, platform = process.platform, run = launchctl }) {
  if (platform !== 'darwin') return { plist: null, state: 'not added: launchd is macOS only, so routines run only when `channels tick` is run' };
  const plist = plistPath(home, label);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(store, { recursive: true });
  writeAtomic(plist, plistText({ label, wrapper, home, log: join(store, 'launchd.log') }));
  run(['bootout', `gui/${uid()}/${label}`]);
  const r = run(['bootstrap', `gui/${uid()}`, plist]);
  return { plist, state: r.status === 0 ? `loaded as ${label}, every minute` : `written, but launchctl couldn't load it: ${`${r.stderr || r.stdout || ''}`.trim()}` };
}

export function uninstall(o, { home = homedir(), platform = process.platform, run = launchctl, log = console.log } = {}) {
  const gone = [];
  if (platform === 'darwin') {
    run(['bootout', `gui/${uid()}/${o.label}`]);
    const plist = plistPath(home, o.label);
    if (existsSync(plist)) {
      if (!readFileSync(plist, 'utf8').includes("herdr-channels' install.mjs")) log(`${plist} isn't from this install; it's left alone.`);
      else { rmSync(plist, { force: true }); gone.push(plist); }
    }
  }
  const wrapper = join(o.bin, 'channels');
  if (existsSync(wrapper)) {
    if (readFileSync(wrapper, 'utf8').includes(MARK)) { rmSync(wrapper, { force: true }); gone.push(wrapper); } else log(`${wrapper} isn't from this install; it's left alone.`);
  }
  if (existsSync(o.chatMod)) {
    if (existsSync(join(o.chatMod, MOD_MARK))) { rmSync(o.chatMod, { recursive: true, force: true }); gone.push(o.chatMod); } else log(`${o.chatMod} isn't from this install; it's left alone.`);
  }
  let mods = [];
  try { mods = readdirSync(join(o.appHome, 'mods')); } catch { /* none */ }
  for (const name of mods) {
    let mine = null;
    try { mine = JSON.parse(readFileSync(join(o.appHome, 'mods', name, MOD_MARK), 'utf8')); } catch { continue; }
    const layout = join(o.appHome, 'layouts', `${mine.layout || name}.json`);
    if (existsSync(layout)) { rmSync(layout, { force: true }); gone.push(layout); }
    rmSync(join(o.appHome, 'mods', name), { recursive: true, force: true });
    gone.push(join(o.appHome, 'mods', name));
  }
  return gone;
}

export function install(o, { home = homedir(), env = process.env, log = console.log, platform = process.platform, run = launchctl } = {}) {
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

  if (o.dryRun) return { wrapper, modDir, layoutFile, name, update, config, found, selected: null, chatMod: o.chatMod };

  mkdirSync(o.bin, { recursive: true });
  writeAtomic(wrapper, wrapperText({ node, script, store: o.store, projects: o.projects, path, chatMod: o.chatMod, mod: name, appHome: o.appHome, app: herdrApp(home) }));
  spawnSync('chmod', ['755', wrapper]);
  copyMod(join(REPO, 'mods', 'channels'), modDir);
  copyChatMod(join(REPO, 'mods', 'claude'), o.chatMod);
  writeAtomic(join(modDir, 'config.js'), configText(config));
  writeAtomic(join(modDir, MOD_MARK), `${JSON.stringify({ repo: REPO, layout: name, at: new Date().toISOString() }, null, 2)}\n`);
  mkdirSync(dirname(layoutFile), { recursive: true });
  writeAtomic(layoutFile, `${JSON.stringify(layout, null, 2)}\n`);
  mkdirSync(o.projects, { recursive: true });
  const selected = o.switch ? selectLayout(o.appHome, name, home) : 'not selected (--no-switch)';
  const timer = o.timer ? installTimer({ label: o.label, wrapper, store: o.store, home, platform, run }) : { plist: null, state: 'not added (--no-timer)' };
  return { wrapper, modDir, layoutFile, name, update, config, found, selected, timer, chatMod: o.chatMod };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parse(process.argv.slice(2));
    if (o.uninstall) {
      const gone = uninstall(o);
      console.log(gone.length ? `Removed:\n${gone.map((g) => `  ${g}`).join('\n')}` : 'Nothing from this install was found.');
      console.log(`The channel store and Claude Code's sessions are left in place.`);
      process.exit(0);
    }
    const r = install(o);
    const missing = Object.entries(r.found).filter(([, p]) => !p).map(([n]) => n);
    console.log(`${o.dryRun ? 'Would install' : 'Installed'} herdr-channels from ${REPO}:`);
    console.log(`  command  ${r.wrapper}`);
    console.log(`  mod      ${r.modDir}${r.update ? ' (updated)' : ''}`);
    console.log(`  layout   ${r.layoutFile}${r.name !== 'channels' ? `  ("channels" was taken, so this is "${r.name}")` : ''}`);
    console.log(`  cards    ${r.chatMod} (the task cards mod each channel's chat loads)`);
    console.log(`  store    ${o.store}`);
    console.log(`  projects ${o.projects}`);
    if (r.selected) console.log(`  The ${r.name} layout is ${r.selected}.`);
    if (r.timer) console.log(`  timer    ${r.timer.plist ? `${r.timer.plist}: ` : ''}${r.timer.state}`);
    if (missing.length) console.log(`\nNot found: ${missing.join(', ')}. Install ${missing.includes('hc') ? 'the herdr app (it brings hc), ' : ''}${missing.filter((m) => m !== 'hc').join(' and ') || ''} and run this again.`);
    if (!`${process.env.PATH}`.split(delimiter).includes(o.bin)) console.log(`\n${o.bin} isn't on your PATH. Add it to use \`channels\` in a terminal; the mod and chats find it without that.`);
    console.log(`\nClaude Code starts background sessions only in a folder you trust: run \`claude\` once in ${o.projects} and accept, if you haven't.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
