#!/usr/bin/env node
// Installs herdr-channels on this Mac, from this clone:
//   node install.mjs [--app-home <dir>] [--bin <dir>] [--store <dir>] [--projects <dir>] [--by <who>] [--label <label>] [--remote-control | --no-remote-control] [--cloud | --no-cloud] [--codex | --no-codex] [--no-timer] [--no-switch] [--dry-run]
//   node install.mjs --on <machine> --command <command> --local <name> --projects <dir> [--by <who>] [--name <name>] [--app-home <dir>] [--no-switch] [--dry-run]
//   node install.mjs --uninstall [--app-home <dir>] [--bin <dir>] [--label <label>]
//
// With --on, the store is another channels command on another Herdr machine (a home server that keeps the channels
// and runs tasks on several machines), and only the mod and its layout are installed here: steps 2 to 4. --command
// is that command (words, e.g. "hub channels"), --local what it calls this computer, --projects where a chat and a
// fresh session start on that machine, and --name the mod and layout's name (to install beside another copy). The
// mod asks the command what it can do and hides the rest (mods/channels/backend.js).
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
// 6. Remote Control (off unless asked for): with --remote-control the command gets CHANNELS_REMOTE_CONTROL=1, and
//    the chats and tasks `channels` starts also show at claude.ai/code. --no-remote-control turns it off again; an
//    install with neither keeps what the command had, and a first install in a terminal asks. Claude Code's own
//    settings are never touched.
// 7. Cloud tasks (off unless asked for, and never asked about): with --cloud the command gets CHANNELS_CLOUD=1, and
//    `channels start --cloud` runs tasks as Claude Code cloud sessions at claude.ai/code. It rides on Claude Code's
//    private sessions API and reads Claude Code's stored claude.ai login (see the README, "Cloud tasks"). --no-cloud
//    turns it off again; an install with neither keeps what the command had. Claude Code's settings are never touched.
// 7b. Codex tasks (on when `codex` is found, unless --no-codex): the command gets CHANNELS_CODEX, and `channels start
//    --harness codex` (or a channel's default) runs a task on OpenAI's Codex CLI, in Codex's own background service
//    (see the README, "Codex tasks"). An install with neither flag keeps what the command had; a command from before
//    Codex tasks gets them when codex is found. Codex's settings are never touched.
// 8. Stamps the build (build.json in the store: an id over the code and settings a channel's chat runs, and the
//    version, from the clone's release tag), and restarts the chats that run an older one: each idle chat at once, on
//    the same session; one that is mid-turn when its turn ends (the timer's next tick). Nothing has to be restarted by
//    hand. See "updates" in bin/channels.mjs. It also records the options it was given (install.json in the store),
//    so `channels update` (and the sidebar's Update button) can install a newer release the same way: bin/release.mjs.
// --uninstall takes out what an install put in: the timer, the command and the mod and layout this repo installed
// (a mod folder marked with .herdr-channels.json, and its layout). It never touches anything it didn't install, nor
// the channel store or any Claude Code session.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneVersion, writeInstall } from './bin/release.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
const MARK = '# herdr-channels: written by install.mjs';
const MOD_MARK = '.herdr-channels.json';
// What herdr writes into a mod folder itself: never copied, and left alone in an installed copy.
const GENERATED = new Set(['gpui-kit.d.ts', 'jsconfig.json', MOD_MARK, 'config.js']);

const usage = 'usage: node install.mjs [--app-home <dir>] [--bin <dir>] [--chat-mod <dir>] [--store <dir>] [--projects <dir>] [--by <who>] [--name <name>] [--label <label>] [--remote-control | --no-remote-control] [--cloud | --no-cloud] [--codex | --no-codex] [--no-timer] [--no-switch] [--dry-run]\n       node install.mjs --on <machine> --command <command> --local <name> --projects <dir> [--by <who>] [--name <name>] [--app-home <dir>] [--no-switch] [--dry-run]\n       node install.mjs --uninstall [--app-home <dir>] [--bin <dir>] [--chat-mod <dir>] [--label <label>]';
export const LABEL = 'dev.herdr-channels.tick';

export function parse(argv, env = process.env, home = homedir()) {
  const o = { appHome: env.HERDR_APP_HOME || join(home, '.config', 'herdr-app'), bin: join(home, '.local', 'bin'), chatMod: join(home, '.local', 'share', 'herdr-channels', 'chat-mod'), store: join(home, '.local', 'state', 'herdr-channels'), projects: join(home, 'projects'), by: 'user', switch: true, dryRun: false, timer: true, uninstall: false, label: LABEL, remote: null, cloud: null, codex: null, on: null, command: null, local: null, name: null };
  const valued = { '--app-home': 'appHome', '--bin': 'bin', '--chat-mod': 'chatMod', '--store': 'store', '--projects': 'projects', '--by': 'by', '--label': 'label', '--on': 'on', '--command': 'command', '--local': 'local', '--name': 'name' };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-switch') o.switch = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-timer') o.timer = false;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--remote-control') o.remote = true;
    else if (a === '--no-remote-control') o.remote = false;
    else if (a === '--cloud') o.cloud = true;
    else if (a === '--no-cloud') o.cloud = false;
    else if (a === '--codex') o.codex = true;
    else if (a === '--no-codex') o.codex = false;
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (valued[a]) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.\n${usage}`);
      o[valued[a]] = argv[++i];
      given.add(a);
    } else throw new Error(`Unknown option ${a}.\n${usage}`);
  }
  const expand = (p) => resolve(p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
  // A store on another machine: its projects folder is that machine's, so it is taken as given.
  for (const k of ['appHome', 'bin', 'store', 'chatMod', ...(o.on ? [] : ['projects'])]) o[k] = expand(o[k]);
  if (o.on != null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.on)) throw new Error('--on is a Herdr machine\'s name, as `hc machine ls` lists it.');
    const words = `${o.command ?? ''}`.trim().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error('--on needs --command: the channels command on that machine, e.g. "hub channels".');
    o.command = words;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(`${o.local ?? ''}`)) throw new Error('--on needs --local: what that store calls this computer (its tasks here are filed as <local>/<session>).');
    if (!given.has('--projects') || !o.projects.startsWith('/')) throw new Error('--on needs --projects: the absolute folder on that machine where a chat and a fresh session start.');
  } else if (o.command != null || o.local != null) throw new Error('--command and --local are for a store on another machine: give --on too.');
  if (o.name != null && !/^[a-z][a-z0-9_-]{0,31}$/.test(o.name)) throw new Error('--name is one short lowercase word, e.g. channels-hc.');
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

// Whether the installed command has Remote Control on: null when there is no command from this install yet.
export function installedRemote(bin) {
  try {
    const text = readFileSync(join(bin, 'channels'), 'utf8');
    return text.includes(MARK) ? /CHANNELS_REMOTE_CONTROL:-1/.test(text) : null;
  } catch { return null; }
}

// Whether the installed command has cloud tasks on: null when there is no command from this install yet.
export function installedCloud(bin) {
  try {
    const text = readFileSync(join(bin, 'channels'), 'utf8');
    return text.includes(MARK) ? /CHANNELS_CLOUD:-1/.test(text) : null;
  } catch { return null; }
}

// Whether the installed command has Codex tasks on: null when there is no command from this install yet, or one from
// before Codex tasks (it says neither).
export function installedCodex(bin) {
  try {
    const text = readFileSync(join(bin, 'channels'), 'utf8');
    if (!text.includes(MARK)) return null;
    return /CHANNELS_CODEX:-1/.test(text) ? true : /CHANNELS_CODEX:-0/.test(text) ? false : null;
  } catch { return null; }
}

export const REMOTE_QUESTION = [
  'Remote Control for channel chats and tasks?',
  "With it on, each channel's chat and every task channels starts also shows at claude.ai/code",
  'and in the Claude app, where you can follow and answer it. Their transcripts (so code and',
  "command output) go through the claude.ai account this Mac's Claude Code is signed in to. On a",
  'Team or Enterprise plan, the organization has to allow Remote Control. Check first: README,',
  '"Remote Control".',
].join('\n');

const sq = (s) => `'${`${s}`.replace(/'/g, `'\\''`)}'`;

export function wrapperText({ node, script, store, projects, path, chatMod = null, mod = null, appHome = null, app = null, remote = false, cloud = false, codex = false }) {
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
    // Remote Control for the chats and tasks channels starts: install.mjs --remote-control, --no-remote-control.
    ...keep('CHANNELS_REMOTE_CONTROL', remote ? '1' : null),
    // Cloud tasks (channels start --cloud): install.mjs --cloud, --no-cloud.
    ...keep('CHANNELS_CLOUD', cloud ? '1' : null),
    // Codex tasks (channels start --harness codex): install.mjs --codex, --no-codex. Written either way, so an update
    // keeps an install's "off".
    ...keep('CHANNELS_CODEX', codex ? '1' : '0'),
    `exec ${sq(node)} ${sq(script)} "$@"`,
    '',
  ].join('\n');
}

export function configText(c) {
  return `// Written by herdr-channels' install.mjs. Install again to change it.\nexport default ${JSON.stringify(c, null, 2)};\n`;
}

// The mod folder and layout name to install as: "channels", or the next free name when "channels" is taken by
// something this repo didn't install. `want` (--name) is the one name to use: it has to be free, or this repo's.
export function pickNames(appHome, want = null) {
  for (let n = 1; n < 100; n++) {
    const name = want ?? (n === 1 ? 'channels' : `channels-${n}`);
    const modDir = join(appHome, 'mods', name);
    const layoutFile = join(appHome, 'layouts', `${name}.json`);
    let mine = null;
    try { mine = JSON.parse(readFileSync(join(modDir, MOD_MARK), 'utf8')); } catch { /* not ours */ }
    const modFree = !existsSync(modDir) || Boolean(mine);
    const layoutFree = !existsSync(layoutFile) || mine?.layout === name;
    if (modFree && layoutFree) return { name, update: Boolean(mine) };
    if (want) throw new Error(`${want} is taken in ${appHome} by a mod or layout this repo didn't install; it's left alone. Pass another --name.`);
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

// The build a chat runs: everything under bin/ and mods/claude, and the command's settings (the wrapper). The mod
// (mods/channels) isn't in it: herdr reloads a mod whose files change, and no chat needs restarting for it.
export function buildId(repo, wrapper) {
  const h = createHash('sha256');
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const f = join(d, n);
      if (n === 'types' || n === MOD_MARK || n === 'node_modules') continue;
      if (statSync(f).isDirectory()) walk(f);
      else h.update(`${f.slice(repo.length)}\n`).update(readFileSync(f)).update('\n');
    }
  };
  walk(join(repo, 'bin'));
  walk(join(repo, 'mods', 'claude'));
  h.update(wrapper);
  return h.digest('hex').slice(0, 12);
}

// The clone's commit, for people to read ("3f2a1bc", "3f2a1bc+" with changes not committed); null outside git.
function commitLabel(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return null;
  const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: 10_000 });
  return `${r.stdout.trim()}${dirty.status === 0 && dirty.stdout.trim() ? '+' : ''}`;
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

  if (o.on) return installRemote(o, { home, log, node });
  // 1. The command.
  const wrapper = join(o.bin, 'channels');
  if (existsSync(wrapper) && !readFileSync(wrapper, 'utf8').includes(MARK)) {
    throw new Error(`${wrapper} exists and isn't from this install; it's left alone. Pass --bin <another folder on PATH>.`);
  }
  // 2. The mod and layout.
  if (!existsSync(o.appHome)) log(`${o.appHome} doesn't exist yet; it is made now. Open the herdr app once to fill it in.`);
  const { name, update } = pickNames(o.appHome, o.name);
  const { modDir, layoutFile, layout } = modFiles(o.appHome, name);
  const version = cloneVersion(REPO);
  const config = { mod: name, layout: name, command: wrapper, path, projects: o.projects, by: o.by, version };

  const was = installedRemote(o.bin);
  const remote = o.remote ?? was ?? false;
  const cloudWas = installedCloud(o.bin);
  const cloud = o.cloud ?? cloudWas ?? false;
  const codexWas = installedCodex(o.bin);
  const codexAt = found.codex ?? findProgram('codex', { env, home });
  const codex = o.codex ?? codexWas ?? Boolean(codexAt);
  if (o.dryRun) return { wrapper, modDir, layoutFile, name, update, config, found, selected: null, chatMod: o.chatMod, remote, was: was ?? false, cloud, cloudWas: cloudWas ?? false, codex, codexWas: codexWas ?? false, codexAt };

  mkdirSync(o.bin, { recursive: true });
  const wrapperBody = wrapperText({ node, script, store: o.store, projects: o.projects, path, chatMod: o.chatMod, mod: name, appHome: o.appHome, app: herdrApp(home), remote, cloud, codex });
  writeAtomic(wrapper, wrapperBody);
  spawnSync('chmod', ['755', wrapper]);
  copyChatMod(join(REPO, 'mods', 'claude'), o.chatMod);
  writeMod({ modDir, layoutFile, layout, name, config });
  mkdirSync(o.projects, { recursive: true });
  const selected = o.switch ? selectLayout(o.appHome, name, home) : 'not selected (--no-switch)';
  const timer = o.timer ? installTimer({ label: o.label, wrapper, store: o.store, home, platform, run }) : { plist: null, state: 'not added (--no-timer)' };
  // 8. The build, last: a chat restarted from here on finds everything above in place.
  const id = buildId(REPO, wrapperBody);
  mkdirSync(o.store, { recursive: true });
  writeAtomic(join(o.store, 'build.json'), `${JSON.stringify({ id, label: commitLabel(REPO) ?? id, version, at: new Date().toISOString() })}\n`);
  writeInstall(o.store, { repo: REPO, args: installArgs(o, name), at: new Date().toISOString() });
  const refreshed = refreshChats(wrapper);
  return { wrapper, modDir, layoutFile, name, update, config, found, selected, timer, refreshed, build: id, version, chatMod: o.chatMod, remote, was: was ?? false, cloud, cloudWas: cloudWas ?? false, codex, codexWas: codexWas ?? false, codexAt };
}

// The options an update installs with again: this install's, with the name it got. Remote Control and cloud tasks
// aren't in it: an install keeps what the command has.
export function installArgs(o, name) {
  return ['--app-home', o.appHome, '--bin', o.bin, '--chat-mod', o.chatMod, '--store', o.store, '--projects', o.projects, '--by', o.by, '--name', name, '--label', o.label, ...(o.timer ? [] : ['--no-timer'])];
}

// The same for an install for a store on another machine.
export function remoteArgs(o, name) {
  return ['--on', o.on, '--command', o.command.join(' '), '--local', o.local, '--projects', o.projects, '--by', o.by, '--name', name, '--app-home', o.appHome, '--store', o.store];
}

// The mod's folder and layout file under a name, and the layout with its mod blocks renamed to match.
function modFiles(appHome, name) {
  const layout = JSON.parse(readFileSync(join(REPO, 'layouts', 'channels.json'), 'utf8'));
  const rename = (n) => { if (n?.content?.mod === 'channels') n.content.mod = name; for (const c of n?.children ?? []) rename(c); };
  rename(layout);
  return { modDir: join(appHome, 'mods', name), layoutFile: join(appHome, 'layouts', `${name}.json`), layout };
}

function writeMod({ modDir, layoutFile, layout, name, config }) {
  copyMod(join(REPO, 'mods', 'channels'), modDir);
  writeAtomic(join(modDir, 'config.js'), configText(config));
  writeAtomic(join(modDir, MOD_MARK), `${JSON.stringify({ repo: REPO, layout: name, at: new Date().toISOString() }, null, 2)}\n`);
  mkdirSync(dirname(layoutFile), { recursive: true });
  writeAtomic(layoutFile, `${JSON.stringify(layout, null, 2)}\n`);
}

// A store on another machine (--on): the mod and its layout only. No command, cards mod, timer or chats here: the
// store, its chats and their schedule are that machine's. What updates this install is here, though: the mod asks this
// clone's `channels update --status` now and then (no launchd tick looks for releases here), in a folder of its own
// under --store (build.json with the version, install.json with these options, release.json), and its Update button
// runs `channels update --bg` there, which fast-forwards the clone and installs the mod again with the same options.
export const remoteState = (o, name) => join(o.store, name);
export function installRemote(o, { home = homedir(), log = console.log, node = process.execPath } = {}) {
  if (!existsSync(o.appHome)) log(`${o.appHome} doesn't exist yet; it is made now. Open the herdr app once to fill it in.`);
  const { name, update } = pickNames(o.appHome, o.name);
  const { modDir, layoutFile, layout } = modFiles(o.appHome, name);
  // PATH for what runs on this computer (hc, python3, and claude for this computer's own tasks).
  const found = Object.fromEntries(['claude', 'hc', 'python3'].map((p) => [p, findProgram(p, { home })]));
  const SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const path = [...new Set([dirname(node), ...Object.values(found).filter(Boolean).map((p) => dirname(p)), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])].filter((d) => !SYSTEM.includes(d)).join(':');
  const version = cloneVersion(REPO);
  const state = remoteState(o, name);
  const updater = { script: join(REPO, 'bin', 'channels.mjs'), dir: state };
  const config = { mod: name, layout: name, command: o.command, on: o.on, local: o.local, path, projects: o.projects, by: o.by, version, updater };
  const result = { remoteStore: true, modDir, layoutFile, name, update, config, found, selected: null, timer: null, refreshed: null };
  if (o.dryRun) return result;
  writeMod({ modDir, layoutFile, layout, name, config });
  mkdirSync(state, { recursive: true });
  writeAtomic(join(state, 'build.json'), `${JSON.stringify({ id: version ?? 'none', label: commitLabel(REPO) ?? version ?? 'none', version, at: new Date().toISOString() })}\n`);
  writeInstall(state, { repo: REPO, args: remoteArgs(o, name), at: new Date().toISOString() });
  result.selected = o.switch ? selectLayout(o.appHome, name, home) : 'not selected (--no-switch)';
  return result;
}

// Restarts the chats that run an older build, through the command just written: { summary } or { error }. An idle
// chat restarts in a few seconds; herdr-core may hold the /exit for up to a minute while someone has a draft typed.
function refreshChats(wrapper) {
  const r = spawnSync(wrapper, ['refresh', '--auto', '--json'], { encoding: 'utf8', timeout: 10 * 60_000 });
  try { return { summary: JSON.parse(r.stdout).summary }; } catch { return { error: `${r.stderr || r.stdout || r.error?.message || `exit ${r.status}`}`.trim().split('\n').pop() }; }
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
    // Remote Control: asked on a first install in a terminal, when no option says.
    if (o.remote == null && installedRemote(o.bin) == null && process.stdin.isTTY && !o.dryRun) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`${REMOTE_QUESTION}\nTurn it on for this Mac? [y/N] `);
      rl.close();
      o.remote = /^y(es)?$/i.test(a.trim());
      console.log('');
    }
    const r = install(o);
    if (r.remoteStore) {
      console.log(`${o.dryRun ? 'Would install' : 'Installed'} the herdr-channels mod from ${REPO}, for the store on ${o.on}:`);
      console.log(`  mod      ${r.modDir}${r.update ? ' (updated)' : ''}`);
      console.log(`  layout   ${r.layoutFile}`);
      console.log(`  store    \`${o.command.join(' ')}\` on ${o.on}, which calls this computer ${o.local}`);
      console.log(`  projects ${o.projects} on ${o.on}`);
      console.log(`  version  ${r.config.version ?? 'none: this clone has no release tag (git fetch --tags)'}; the sidebar offers each new release`);
      console.log(`  chats    The mod reloaded; the chats on ${o.on} keep running.`);
      if (r.selected) console.log(`  The ${r.name} layout is ${r.selected}.`);
      if (!r.found.hc) console.log('\nNot found: hc. Install the herdr app (it brings hc) and run this again.');
      process.exit(0);
    }
    const missing = Object.entries(r.found).filter(([, p]) => !p).map(([n]) => n);
    console.log(`${o.dryRun ? 'Would install' : 'Installed'} herdr-channels from ${REPO}:`);
    console.log(`  version  ${r.config.version ?? 'none: this clone has no release tag (git fetch --tags)'}`);
    console.log(`  command  ${r.wrapper}`);
    console.log(`  mod      ${r.modDir}${r.update ? ' (updated)' : ''}`);
    console.log(`  layout   ${r.layoutFile}${r.name !== 'channels' ? `  ("channels" was taken, so this is "${r.name}")` : ''}`);
    console.log(`  cards    ${r.chatMod} (the task cards mod each channel's chat loads)`);
    console.log(`  store    ${o.store}`);
    console.log(`  projects ${o.projects}`);
    if (r.selected) console.log(`  The ${r.name} layout is ${r.selected}.`);
    console.log(`  remote   ${r.remote ? 'on: new tasks and chats show at claude.ai/code (--no-remote-control turns it off)' : 'off (--remote-control turns it on; see the README, "Remote Control")'}`);
    console.log(`  cloud    ${r.cloud ? 'on: channels start --cloud runs tasks at claude.ai/code (--no-cloud turns it off)' : 'off (--cloud turns it on; see the README, "Cloud tasks")'}`);
    console.log(`  codex    ${r.codex ? `on: channels start --harness codex runs tasks on Codex${r.codexAt ? '' : ' (codex isn\'t installed yet)'} (--no-codex turns it off)` : `off (--codex turns it on${r.codexAt ? '' : ', once codex is installed'}; see the README, "Codex tasks")`}`);
    if (r.timer) console.log(`  timer    ${r.timer.plist ? `${r.timer.plist}: ` : ''}${r.timer.state}`);
    if (r.refreshed) console.log(`  chats    ${r.refreshed.summary ?? `not refreshed: ${r.refreshed.error}. The Refresh row in the channels sidebar does it.`}`);
    if (missing.length) console.log(`\nNot found: ${missing.join(', ')}. Install ${missing.includes('hc') ? 'the herdr app (it brings hc), ' : ''}${missing.filter((m) => m !== 'hc').join(' and ') || ''} and run this again.`);
    if (!`${process.env.PATH}`.split(delimiter).includes(o.bin)) console.log(`\n${o.bin} isn't on your PATH. Add it to use \`channels\` in a terminal; the mod and chats find it without that.`);
    if (!o.dryRun && o.remote != null && r.remote !== r.was) console.log(`\nRemote Control is now ${r.remote ? 'on' : 'off'} for what channels starts from here. Running chats have restarted with it (or do when their turn ends). Tasks keep what they started with.`);
    if (!o.dryRun && o.cloud != null && r.cloud !== r.cloudWas) console.log(`\nCloud tasks are now ${r.cloud ? 'on' : 'off'} here. Running chats have restarted ${r.cloud ? 'and watch their cloud tasks' : 'and stop watching cloud tasks'} (or do when their turn ends).${r.cloud ? ' They read Claude Code\'s stored claude.ai login and call its private API: see the README, "Cloud tasks".' : ''}`);
    if (!o.dryRun && r.codex !== r.codexWas && (o.codex != null || r.codex)) console.log(`\nCodex tasks are ${r.codex ? 'on' : 'off'} here. ${r.codex ? 'Tasks run on Claude Code unless you ask for Codex (channels start --harness codex, the panel\'s + menu, or a channel\'s Tasks run on). Codex must be signed in (codex login).' : 'Codex tasks already filed stay listed with what was last known.'}`);
    console.log(`\nClaude Code starts background sessions only in a folder you trust: run \`claude\` once in ${o.projects} and accept, if you haven't.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
