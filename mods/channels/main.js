// channels: a channels front end for herdr, laid out like Claude Duet. One mod in several roles,
// placed by layouts/channels.json and by its own overlays:
//
// - the sidebar (no props): the channels, each with an icon and an L-shaped connector, a "…"
//   menu on hover and "New channel" at the bottom. It also reads the `channels` store on this
//   machine on a timer and shares the result, so the other copies never poll.
//   Under the channels, "Spaces": Herdr's own spaces (all but the chats' space), by machine. Clicking one shows it
//   in the main area, with Herdr's keys for tabs and splits; the tasks panel folds away until a channel is picked.
// - the bar ({ bar: true }): what the main area is showing (a channel, or a space and its tabs), and the button
//   for the tasks panel.
// - the panel ({ panel: true }): "Tasks in #channel". A task is one Claude Code session; clicking
//   one shows it live in the panel. + starts a fresh session in the projects folder.
// - the menu ({ menu: channel }) and the dialogs ({ dialog: "new" | "rename" | "instructions" |
//   "icon" | "routines" | "archive", channel }), opened as overlays; a task's menu ({ taskmenu:
//   task id }) and its Rename dialog ({ dialog: "rename-task", task: task id }) too, and a cloud task's Send
//   dialog ({ dialog: "send-task", task: task id }).
//
// The main area is herdr's shown tab. A channel's chat runs in one herdr-core terminal, named
// chat-<channel id>, which `channels chat <name> --bg` starts (a routine starts the same one when
// the chat is closed). It is shown as a tab in a herdr space called "channels", made on first use
// and reused after. By default everything runs on this machine: the
// `channels` command (bin/channels.mjs in the herdr-channels repo) holds the store, and
// config.js beside this file says where it is. config.js can instead point at a store on another
// machine (`hub channels` on a home server: see backend.js). Then the store's commands run
// there, tasks can be on any machine Herdr knows, and, when that command can't start a chat in the
// background, the chat is a tab in that machine's "channels" space running `<command> chat <name>`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Switch, RadioGroup, Radio } from "gpui-base";
import { EMOJI, GROUPS } from "./emoji.js";
import CONFIG from "./config.js";
import { chatAlive, afterEnd, lastLine, QUICK_MS } from "./chats.js";
import { remember, restore, keyOf } from "./panels.js";
import { refreshRow, releaseRow, versionLabel } from "./updates.js";
import { follow } from "./spaces.js";
import * as B from "./backend.js";
import { exec, hc, readTextFile, appHome, spaces, panes, terminals, layout, theme, run, nextCommand, home, props, shared, setShared, openOverlay, closeOverlay, window, machines } from "herdr";

// The settings, from config.js (install.mjs writes it). MOD and LAYOUT are this mod's folder and
// its layout's name, which the install changes when "channels" is already taken.
const MOD = CONFIG.mod || "channels";
const LAYOUT = CONFIG.layout || "channels";
// The store: which command, on which machine, and what it calls this computer (backend.js).
const BACKEND = B.backendOf(CONFIG, home());
const ON = BACKEND.on; // the Herdr machine the store's command runs on; null is this computer
// Where it, node, claude, hc and python3 are: a program started from the app gets a short PATH.
const PATHS = [CONFIG.path, "$HOME/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
const PROJECTS = BACKEND.projects; // where a fresh session and a channel chat start, on the store's machine
const LOCAL_PROJECTS = BACKEND.localProjects; // and where one starts on this computer
const BY = BACKEND.by; // who a task resolved here is recorded as resolved by
const HOLD = "channels"; // the herdr space that holds the chats' tabs
const TASKS_PANEL = "tasks-panel"; // the layout node of the tasks panel ("panel" is Herdr's own Files/Changes panel)
// This mod's keys in herdr's shared state: "channels.data" and so on, under its own folder's name, so a second copy
// installed beside it (mods/channels-hc) keeps its own.
const K = (word) => B.keyOf(MOD, word);
const DATA = K("data"); // what the sidebar last read: { channels, error, at }
const TICK = K("tick"); // bumped after a change so the sidebar reads the store again
const CURRENT = K("current"); // the selected channel's name
const ORDER = K("order"); // this computer's channel order (ids), until the store keeps one
const TASK = K("task"); // the id of the task open in the tasks panel, if any
const TASK_TERM = K("taskterm"); // and the address of the terminal showing it
const LIST_FOCUS = K("listfocus"); // when the panel went back to the task list, so the list takes the keyboard
const LAST_TASK = K("lasttask"); // the task that was open, so the list's cursor starts on it
const OPENED = K("opened"); // when a task was last opened in the panel, so its prompt takes the keyboard
// What each channel's panel showed last: channel id -> null (the list) or { id, job } (a task), so coming back to
// a channel shows it again (see panels.js). Shared state is saved to shared.json, so this outlasts a restart.
const PANELS = K("panels");
const rememberPanel = (channel, task) => { if (channel) setShared(PANELS, remember(shared(PANELS), channel, task)); };
const DEFAULT_ICON = "💬"; // every channel has an icon; this is the one a new channel starts with
const iconOf = (channel) => channel?.icon || DEFAULT_ICON;
const FRESH = "New session";
// Every task is a background session shown through the viewer, viewer.py beside this file: `claude
// attach` behind a pass-through terminal that notices the moment you leave the session (left
// arrow on an empty prompt, /exit, ctrl+z), marks its terminal with the "herdr.back" label, which
// the panel watches to return to the task list, and attaches again for the next visit. The file
// says why it exists. It is sent as the program text, so only python3 is needed.
// Remote Control: on when the installed `channels` has it on (install.mjs --remote-control), as `channels list`
// says. Then a fresh session and an old session opened here also show at claude.ai/code.
const remoteOn = () => shared(DATA)?.remote === true;
const resumeSettings = () => ["--settings", JSON.stringify({ disableAgentView: true, ...(remoteOn() ? { remoteControlAtStartup: true } : {}) })];
// A task's claude.ai/code link opens in the browser with macOS `open`: only a link of that shape.
const CLAUDE_AI = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/;
const remoteLink = (task) => (CLAUDE_AI.test(task?.remote_url ?? "") ? task.remote_url : null);
const openRemote = async (task) => {
  const url = remoteLink(task);
  if (!url) return;
  const r = await exec("open", [url], { timeout: 20000 });
  if (r.code !== 0) fail(`Couldn't open ${url}: ${(r.stderr.trim() || `open exited ${r.code}`).split("\n").pop()}`);
};
// Cloud tasks (install.mjs --cloud): a task can be a Claude Code cloud session at claude.ai/code, filed as
// cloud/<session_…>. `channels list` gives its state from the account's sessions list (`cloud` on the task). It opens
// in a terminal (`claude --cloud <id>`) only when `channels list` says that attaches for this account; otherwise on
// claude.ai.
const isCloud = (task) => task?.machine === "cloud";
const cloudAttach = () => shared(DATA)?.cloud?.attach === true;
const NOTE = K("note"); // a word after something done here: { message, at }
const note = (message) => setShared(NOTE, { message, at: Date.now() });
const BACK = "herdr.back";
let viewerSource = null;
async function attachTo(id) {
  viewerSource ??= await readTextFile(`${appHome()}/mods/${MOD}/viewer.py`);
  if (!viewerSource) throw new Error(`mods/${MOD}/viewer.py is missing.`);
  return ["python3", "-I", "-c", viewerSource, id];
}
const POLL_MS = 10000;
const ROW = 40; // a channel row's height in the sidebar
const HEAD = 52; // every header's height (the bar, the tasks panel's and a task's), so their lines meet
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN = 216; // emoji cells drawn at once: enough for a group, cheap to draw
const ICON = (name) => `mods/${MOD}/icons/${name}.svg`;

// What the store calls this computer (tasks are filed as `<name>/<session>`): `channels list`
// says, from CHANNELS_MACHINE or the host name; for a store on another machine, config.js's `local`.
const localName = () => B.localName(BACKEND, shared(DATA));
// The machine the store is on, by the store's own name for it: this computer's, or the other machine's.
const storeName = () => shared(DATA)?.machine ?? ON ?? localName();
// What the store's command can do (backend.js): a feature it lacks is hidden, not offered and then refused. The
// sidebar asks it once per load (`channels capabilities --json`) and keeps the answer in shared state; a command that
// doesn't know that question (an older one) is judged by what its `list --json` gives. Until the store has answered
// once, a store on this computer is this repo's command, and one on another machine is taken to have none of them.
// Updating this install is this computer's business, not the store's: with a store on another machine it is there
// when install.mjs set up the updater (config.js `updater`).
const FEATURES = K("features"); // { list: [...] | null (the command doesn't say), at }
const has = (feature) => {
  if (feature === "update" && ON) return Boolean(CONFIG.updater?.script && CONFIG.updater?.dir);
  return (shared(FEATURES)?.list ?? shared(DATA)?.features ?? (ON ? [] : B.ALL_FEATURES)).includes(feature);
};
let askedFeatures = 0; // when this load last asked; 0 is not yet
async function askFeatures() {
  if (askedFeatures && (shared(FEATURES)?.list || Date.now() - askedFeatures < 600000)) return;
  askedFeatures = Date.now();
  const r = await sh("channels capabilities --json", [], { timeout: 30000 });
  setShared(FEATURES, { list: r.code === 0 ? B.capabilitiesOf(r.stdout) : null, at: Date.now() });
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

// Runs a shell line on the store's machine (`on: null` runs it on this one). The folders for PATH
// arrive as $0; `channels` in the line runs the store's command, quoted word by word, and the
// line's own args arrive as "$1", "$2", ...
const sh = (script, args = [], { timeout = 30000, on = ON } = {}) =>
  exec("sh", ["-c", `${B.shellPrelude({ ...BACKEND, on })}${script}`, PATHS, ...args], { timeout, on });

// The same for a command that must succeed: its output, or an Error with its last line.
async function store(script, args, timeout) {
  const r = await sh(script, args, { timeout });
  if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n").pop());
  return r.stdout;
}

const changed = () => setShared(TICK, Date.now());

// Changes show at once and reach the store behind them. `submit` applies the change to what every
// copy is showing and queues the command; the sidebar copy, which lives as long as the layout,
// carries the queue out in order (a dialog can close before its command has run). While commands
// are out, a read of the store that started earlier is ignored, so it can't put the old state back.
const OPS = K("ops"); // queued commands: { script, args, what, at }
const BUSY = K("busy"); // the sidebar is carrying the queue out
const OP_AT = K("opAt"); // when something last changed here
const FAIL = K("fail"); // the last command that failed: { message, at }
const NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/; // the store's rule for a channel name
const fail = (message) => setShared(FAIL, { message, at: Date.now() });
function submit(change, script, args, what) {
  const data = shared(DATA);
  if (data) {
    const next = JSON.parse(JSON.stringify(data.channels));
    change(next);
    setShared(DATA, { ...data, channels: next });
  }
  setShared(OP_AT, Date.now());
  setShared(OPS, [...(shared(OPS) ?? []), { script, args, what, at: Date.now() }]);
}
const eachTask = (all, id, fn) => { for (const c of all) for (const x of c.tasks ?? []) if (x.id === id) fn(x); };

// "3h", "2d": how long ago, short enough for a list row.
function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (!Number.isFinite(m)) return "";
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
const TASK_H = 44; // a task row's height
const GROUP_H = 42; // a group heading's height in the task list


// Where a session stands, from Claude Code's own list: working, needs (it waits on you) or ready.
function standing(agent) {
  if (!agent) return "ready";
  if (agent.state === "blocked" || agent.status === "waiting") return "needs";
  if (agent.state === "working" || agent.status === "busy") return "working";
  return "ready";
}

// The channels, with each task's name and standing as Claude Code has them now.
async function readStore() {
  const out = await store("channels list --json && printf '\\n@@\\n' && (claude agents --json 2>/dev/null || echo '[]')");
  const [list, there] = out.split("\n@@\n");
  const head = JSON.parse(list);
  const channels = head.channels ?? [];
  // Claude Code's list on the store's machine; for a store on another machine, this computer's too, each for the
  // tasks filed under that machine's name. A task on a third machine stays "ready": its list isn't read.
  const indexes = {};
  let fallback = B.agentIndex(there);
  if (ON) {
    indexes[head.machine ?? ON] = fallback;
    fallback = null;
    const mine = localName();
    if (mine) {
      try { indexes[mine] = B.agentIndex((await sh("claude agents --json 2>/dev/null || echo '[]'", [], { on: null })).stdout); } catch { /* none here */ }
    }
  }
  for (const c of channels) {
    for (const t of c.tasks ?? []) {
      // A cloud task's state comes from the account's sessions list, through `channels list`.
      if (isCloud(t)) { t.standing = t.cloud?.state ?? "ready"; continue; }
      const a = B.agentOf(t, indexes, fallback);
      // A copy keeps its task's name, and so does a session renamed here that Claude Code can't rename (see
      // `channels rename-task`): the list's name stands for those.
      if (a?.name && t.how !== "copied" && !t.named) t.name = a.name;
      t.standing = B.standingOf(a ? standing(a) : null, t.standing);
    }
  }
  return { machine: head.machine ?? null, features: B.featuresOf(head), remote: head.remote_control === true, cloud: head.cloud ?? null, updates: head.updates ?? null, channels };
}

// Refresh: the running chats restart on what is installed now (a newer Claude Code, a new herdr-channels build), each
// once it is idle and on the same session. The backend's `channels refresh` does it and says what it did; the sidebar
// carries it out, since it lives as long as the layout.
const REFRESHING = K("refreshing"); // when a refresh started, while it runs
const REFRESHED = K("refreshed"); // what the last one did: { message, at, failed }
async function refreshNow() {
  if (shared(REFRESHING) && Date.now() - shared(REFRESHING) < 600000) return;
  setShared(REFRESHING, Date.now());
  try {
    const out = JSON.parse(await store("channels refresh --json", [], 600000));
    setShared(REFRESHED, { message: out.summary, at: Date.now() });
  } catch (err) {
    setShared(REFRESHED, { message: `Couldn't refresh: ${String(err?.message ?? err)}`, at: Date.now(), failed: true });
  }
  setShared(REFRESHING, null);
  changed();
}

// Update: a newer herdr-channels release, installed when asked (the release row's button). The backend's
// `channels update --bg` does it in its own process, which outlives this mod (the install copies a new one in), and
// `channels list` says how it goes (`updates.release.update`).
const UPDATING = K("updating"); // when Update was clicked, until the list says the update runs
// With a store on another machine, the release is this computer's install's: this clone's `channels update --status`,
// in the install's own folder, asked every RELEASE_MS (it asks GitHub only every few hours), and every few seconds
// while an update runs.
const RELEASE = K("release"); // what that said last, with `at`
const RELEASE_MS = 300000;
const releaseNow = () => (ON ? shared(RELEASE) : shared(DATA)?.updates?.release) ?? null;
const updater = (sub) => sh(`CHANNELS_DIR="$1" exec node "$2" update ${sub} --json`, [CONFIG.updater.dir, CONFIG.updater.script], { on: null, timeout: 30000 });
async function lookForRelease(force = false) {
  if (!ON || !has("update")) return;
  const was = shared(RELEASE);
  const running = was?.update?.state === "running" || pendingClick();
  if (!force && was?.at && Date.now() - was.at < (running ? 3000 : RELEASE_MS)) return;
  setShared(RELEASE, { ...(was ?? {}), at: Date.now() }); // one look at a time
  const r = await updater("--status");
  try { if (r.code === 0) setShared(RELEASE, { ...JSON.parse(r.stdout), at: Date.now() }); } catch { /* the last answer stands */ }
}
// A click the list hasn't caught up with yet: no record of an update since it (for up to 30 s).
const pendingClick = () => {
  const at = shared(UPDATING);
  return Boolean(at) && Date.now() - at < 30000 && !(Date.parse(releaseNow()?.update?.at ?? "") >= at - 2000);
};
async function updateNow() {
  if (pendingClick()) return;
  setShared(UPDATING, Date.now());
  try {
    const out = ON ? JSON.parse((await updater("--bg")).stdout) : JSON.parse(await store("channels update --bg --json", [], 30000));
    if (!out.started) note(out.why);
  } catch (err) {
    fail(`Couldn't start the update: ${String(err?.message ?? err)}`);
    setShared(UPDATING, null);
  }
  changed();
}
// A release's notes open in the browser: only a link to this repo's releases.
const RELEASE_NOTES = /^https:\/\/github\.com\/bensoutendijk\/herdr-channels\/releases\/tag\/v\d+\.\d+\.\d+$/;
async function openNotes(url) {
  if (!RELEASE_NOTES.test(url ?? "")) return;
  const r = await exec("open", [url], { timeout: 20000 });
  if (r.code !== 0) fail(`Couldn't open ${url}: ${(r.stderr.trim() || `open exited ${r.code}`).split("\n").pop()}`);
}

// The channels in the user's order: the store's own (`position`) once it keeps one, else the order
// dragged on this computer, with channels it hasn't seen (new ones) at the bottom, oldest first.
function channels() {
  const all = shared(DATA)?.channels ?? [];
  if (all.some((c) => c.position != null)) return [...all].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  const order = shared(ORDER) ?? [];
  const at = (c) => { const i = order.indexOf(c.id ?? c.name); return i === -1 ? 1e9 : i; };
  return [...all].sort((a, b) => at(a) - at(b) || `${a.created_at}`.localeCompare(`${b.created_at}`));
}
const active = (channel) => (channel?.routines ?? []).some((r) => r.enabled);
const liveTasks = (channel) => (channel?.tasks ?? []).filter((t) => !t.dismissed).sort((a, b) => `${b.added_at}`.localeCompare(`${a.added_at}`));
const doneTasks = (channel) => (channel?.tasks ?? []).filter((t) => t.dismissed).sort((a, b) => `${b.dismissed_at}`.localeCompare(`${a.dismissed_at}`));

// The herdr machine a task runs on: null is this computer, a name is another machine Herdr knows,
// undefined is one we can't reach (backend.js).
function herdrMachine(task) {
  return B.herdrMachine(task, { backend: BACKEND, data: shared(DATA), known: ON ? machines().map((m) => m.name).filter(Boolean) : [] });
}

// Plain Herdr inside the channels window. Under the channels, the sidebar holds Herdr's own spaces list (the shipped
// "spaces" mod, as in Herdr's own layout). While Herdr shows a space other than the chats' (picked there, with Herdr's
// keys, or made with +), the window is plain Herdr for it: Herdr's own tab bar (the shipped "tabs" mod, block
// "space-tabs") stands in for the channel's bar, with its + menu (Terminal, Claude Code, other agents, New space) and its
// Files and Changes panel (node "panel", Herdr's own ids); the tasks panel folds away. Selecting a channel, or the chats'
// space in the list, gives the channel back. SPACE is { space, seen, quiet, folded } (see follow in spaces.js):
// the space shown (null while a channel is), what Herdr showed at the last look, until when a choice made here stands
// while Herdr catches up, and whether the tasks panel was folded away for the space (so leaving it brings it back).
const SPACE = K("space");
const QUIET_MS = 1500;
const inSpace = () => Boolean(shared(SPACE)?.space);
// The window's pieces for a space or a channel: Herdr's tab bar or the channel's bar, and the tasks panel folded away or
// back. Herdr's Files/Changes panel goes with its tab bar. Run on each change and on the sidebar's timer, so the layout
// always ends up matching; a layout from before these blocks existed is left as it is.
function syncSpaceUi() {
  if (shared("layout") !== LAYOUT) return;
  const tree = layout();
  const tabs = find(tree, "space-tabs"), bar = find(tree, "bar");
  if (!tabs || !bar) return;
  const want = inSpace();
  if (Boolean(tabs.hidden) === want) run(want ? "layout.show" : "layout.hide", { id: "space-tabs" });
  if (Boolean(bar.hidden) !== want) run(want ? "layout.hide" : "layout.show", { id: "bar" });
  if (!want && find(tree, "panel") && !find(tree, "panel").hidden) run("layout.hide", { id: "panel" });
  const s = shared(SPACE) ?? {};
  const tasks = find(tree, TASKS_PANEL);
  if (want && !s.folded && tasks && !tasks.hidden) { setShared(SPACE, { ...s, folded: true }); run("layout.hide", { id: TASKS_PANEL }); }
  else if (!want && s.folded) { setShared(SPACE, { ...s, folded: false }); run("layout.show", { id: TASKS_PANEL }); }
}
// Back to the selected channel from a space: the channel takes over at once, before Herdr shows its chat.
function leaveSpace() {
  setShared(SPACE, { ...(shared(SPACE) ?? {}), space: null, quiet: Date.now() + QUIET_MS });
  syncSpaceUi();
  syncMain();
}
// The sidebar's look at what Herdr shows (see follow in spaces.js).
function followSpaces() {
  const was = shared(SPACE) ?? {};
  const next = follow(was, spaces(), HOLD, Date.now());
  if (next.space === (was.space ?? null) && next.seen === (was.seen ?? null)) return;
  setShared(SPACE, { ...was, ...next });
  if (Boolean(next.space) !== Boolean(was.space)) { syncSpaceUi(); syncMain(); }
}

const shortId = (task) => task.job ?? task.session_id.split("-")[0];
const holdSpace = (machine) => spaces().find((p) => (p.machine ?? null) === machine && p.name === HOLD) ?? null;
const tabOf = (space, task) => space?.tabs.find((t) => t.name === shortId(task) || t.name.startsWith(`${shortId(task)} `)) ?? null;

// A task's terminal: one per session, outside any tab: a herdr-core terminal named "cv4-<id>". It
// is started the first time the task is opened and found by name after that.
// VIEWER is the viewer script's version: change it when viewer.py changes, so a terminal still running
// an older script is replaced the next time its task is opened instead of being reused.
const VIEWER = "cv4";
const OLD_VIEWERS = ["ch", "cv3"];
const viewerName = (prefix, task) => `${prefix}-${shortId(task)}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
const termName = (task) => viewerName(VIEWER, task);
function findTerm(task, machine) {
  const there = (address) => (machine ? `${address}`.startsWith(`${machine}/`) : !`${address}`.includes("/"));
  return terminals().find((x) => x.name === termName(task) && x.state === "live" && there(x.address))?.address ?? null;
}

const find = (node, id) => (!node ? null : node.id === id ? node : (node.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));

// Shows a task in the tasks panel, beside the channel's chat: the panel's stack gets a
// "taskview" child holding the task's header and its live terminal. `channel` is the channel it is
// open in (the one holding it, else the selected one): it is remembered there, and shown only if
// that channel is still the selected one (a slow start mustn't pull the panel to another channel).
// `reveal: false` leaves a hidden panel hidden, as a channel switch does; its prompt takes the
// keyboard only if the panel is on screen.
const channelOf = (task) => channels().find((c) => (c.tasks ?? []).some((x) => x.id === task.id)) ?? null;
function showInPanel(task, address, { channel = channelOf(task) ?? current(), reveal = true } = {}) {
  rememberPanel(channel, task);
  if (keyOf(channel) !== keyOf(current())) return;
  const tree = JSON.parse(JSON.stringify(layout()));
  const panel = find(tree, TASKS_PANEL);
  if (!panel) return;
  panel.children = [panel.children.find((n) => n.id === "tasks"), {
    id: "taskview", type: "column", resizable: false,
    children: [
      { id: "taskhead", type: "block", size: { px: HEAD }, content: { mod: MOD, props: { taskhead: true } } },
      { id: "taskterm", type: "block", content: { terminal: address } },
    ],
  }];
  panel.active = "taskview";
  if (reveal) panel.hidden = false;
  setShared(TASK, task.id);
  setShared(TASK_TERM, address);
  run("layout.set", { layout: tree });
  if (panel.hidden) return;
  setShared(OPENED, Date.now());
  run("pane.focus", { terminal: address });
}
// Back to the task list. The selected channel remembers the list, so it opens on the list next time;
// `remember: false` is the panel following a switch to another channel, which leaves what the
// channel left behind remembered.
const showTasks = ({ remember: keep = true } = {}) => {
  if (keep) rememberPanel(current(), null);
  if (shared(TASK)) setShared(LAST_TASK, shared(TASK));
  setShared(TASK, null);
  setShared(LIST_FOCUS, Date.now());
  run("layout.select", { stack: TASKS_PANEL, child: "tasks" });
};

// Opens a task in the panel: a background session is attached to; one from before tasks were all
// background sessions (a plain `claude`, no job) is resumed.
async function openTask(task, where) {
  if (isCloud(task)) return openCloud(task, where);
  const machine = herdrMachine(task);
  if (machine === undefined) throw new Error(`${task.machine} can't be reached from this computer.`);
  let address = findTerm(task, machine);
  if (!address) {
    const there = (a) => (machine ? `${a}`.startsWith(`${machine}/`) : !`${a}`.includes("/"));
    const old = OLD_VIEWERS.map((prefix) => viewerName(prefix, task));
    for (const x of terminals()) if (old.includes(x.name) && there(x.address)) run("terminal.kill", { terminal: x.address });
    const cmd = task.job || !UUID.test(task.session_id) ? await attachTo(shortId(task)) : ["claude", "--resume", task.session_id, ...resumeSettings()];
    // A task on another machine runs its viewer there (sent as program text, so that machine needs only python3),
    // with that machine's ~/.local/bin first on PATH, where Claude Code is.
    const folder = task.folder ?? (machine ? PROJECTS : LOCAL_PROJECTS);
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", termName(task), "--cwd", folder, ...(machine ? ["--on", machine] : []),
      "--", "sh", "-c", machine ? 'PATH="$HOME/.local/bin:$0:$PATH" exec "$@"' : 'PATH="$0:$PATH" exec "$@"', PATHS, ...cmd]);
    if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim() || `hc exited ${r.code}`).split("\n").pop());
    address = JSON.parse(r.stdout).address;
  }
  showInPanel(task, address, where);
}

// A cloud task: `claude --cloud <id>` in a terminal in the panel, when that attaches for this account; else on
// claude.ai in the browser (and the panel stays on the list).
async function openCloud(task, where) {
  if (!cloudAttach()) return openRemote(task);
  let address = findTerm(task, null);
  if (!address) {
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", termName(task), "--cwd", task.folder ?? PROJECTS,
      "--", "sh", "-c", 'PATH="$0:$PATH" exec "$@"', PATHS, "claude", "--cloud", task.session_id]);
    if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim() || `hc exited ${r.code}`).split("\n").pop());
    address = JSON.parse(r.stdout).address;
  }
  showInPanel(task, address, where);
}

// A task card's Open: the chat's cards mod runs `channels open <task>`, which leaves the task in the store and sends
// "open-task" here (a mod command carries no arguments). The task opens as a click on it in the panel does, in its
// channel. A task filed a moment ago may not be in what the sidebar last read yet: read the store again for it.
async function openRequested(cx, refresh) {
  const want = JSON.parse((await store("channels open --take")).trim() || "null");
  if (!want?.task) return;
  const hit = () => {
    for (const c of channels()) { const t = liveTasks(c).find((x) => x.id === want.task); if (t) return { c, t }; }
    return null;
  };
  let found = hit();
  for (let i = 0; !found && i < 20; i++) {
    if (i === 0) refresh();
    await cx.sleep(250);
    found = hit();
  }
  if (!found) throw new Error(`${want.task} isn't a task in any channel here.`);
  if (current()?.name !== found.c.name) openChannel(found.c);
  await openTask(found.t, { channel: found.c });
}

// The panel follows the channel: it shows what this channel's panel showed last, a task (as if it
// were clicked) or the list. A task resolved, gone or out of reach since gives the list.
function followPanel(c) {
  const want = restore(shared(PANELS), c, (x) => herdrMachine(x) !== undefined && (!isCloud(x) || cloudAttach()));
  const toList = () => { if (shared(TASK)) showTasks({ remember: false }); };
  if (!want) return toList();
  if (shared(TASK) === want.id) return;
  // A task whose terminal is running shows at once; one that has to be attached again shows
  // when it's ready, and the list stands in for it meanwhile (not the other channel's task).
  openTask(want, { channel: c, reveal: false }).catch(() => { if (current()?.name === c.name) toList(); });
  if (shared(TASK) !== want.id) toList();
}

// A channel's chat: one long-lived session on this machine, in one herdr-core terminal that
// `channels chat <name> --bg` finds or starts (a routine that fires while the chat is closed starts
// the same one in the background). Opening the channel shows that terminal: the tab already showing
// it, else a new tab in the "channels" space made for it with terminal.keep. A chat an earlier
// version opened as a tab of its own (named "#<channel id>") is shown as before until it ends.
const CHATS = K("chats"); // channel id -> the address of its chat's terminal, as last found
const chatOf = (c) => ({ machine: storeName(), session_id: `#${c.id ?? c.name}`, job: `#${c.id ?? c.name}`, name: "", folder: PROJECTS });
// A store on another machine answers with that machine's own addresses ("t2k"); Herdr here knows them as "<machine>/t2k".
const hereAddress = (address) => B.remoteAddress(address, ON);
const chatAddress = (c) => (shared(CHATS) ?? {})[c.id] ?? hereAddress(c.chat_terminal) ?? null;
const termOf = (address) => (address ? terminals().find((x) => x.address === address) ?? null : null);
// Channels whose chat stopped right after it started: id -> { message, at }. The sidebar doesn't start those
// again on its own; opening the channel (a click) does.
const DOWN = K("down");
const downOf = (c) => (c ? (shared(DOWN) ?? {})[c.id] ?? null : null);
function setDown(c, value) {
  const all = { ...(shared(DOWN) ?? {}) };
  if (value) all[c.id] = value; else delete all[c.id];
  setShared(DOWN, all);
  syncMain();
}
// While the selected channel's chat is down, the main area shows why, with a Retry, instead of herdr's
// shown tab: that would be whatever tab herdr picked when the chat's closed, often another channel's
// chat. The main block's own content is kept aside meanwhile and put back after. The sidebar's
// timer calls this every second too, so the layout always ends up matching.
const MAIN_SAVED = K("main");
// How the main area frames a tab's panes, as layouts/channels.json says: cards, drawn only when a tab is split (a
// space's terminals side by side), so a chat alone shows bare.
const MAIN_PANE = { gap: 6, radius: 6, border: { width: 1, color: "border" }, focus: { width: 1, color: "accent" } };
const isPlaceholder = (content) => content?.mod === MOD && content?.props?.down === true;
function syncMain() {
  if (shared("layout") !== LAYOUT) return;
  const tree = layout();
  const main = find(tree, "main");
  if (!main) return;
  const want = !inSpace() && Boolean(downOf(current())); // a Herdr space shown from the sidebar is never down
  if (want === isPlaceholder(main.content)) return;
  const next = JSON.parse(JSON.stringify(tree));
  const node = find(next, "main");
  if (want) { setShared(MAIN_SAVED, node.content); node.content = { mod: MOD, props: { down: true } }; }
  else node.content = shared(MAIN_SAVED) ?? { tab: "active", pane: MAIN_PANE };
  run("layout.set", { layout: next });
}
const paneOf = (address) => (address ? panes().find((p) => p.terminal === address) ?? null : null);
const spaceOfTab = (tab) => spaces().find((sp) => sp.tabs.some((x) => x.id === tab)) ?? null;
// An earlier version's chat tab (on a store's machine: the chat's own tab, "#<channel id>", from before the chat ran in
// the background), still running its program. `dead` too: one whose program has ended (only a shell is left).
function oldChatTab(c, { dead = false } = {}) {
  const tab = tabOf(holdSpace(ON), chatOf(c));
  if (!tab || (!dead && panes().some((p) => p.tab === tab.id && p.program?.shell))) return null;
  return tab;
}
// Shows the tab that holds this terminal, if one does.
function selectChat(address) {
  const pane = paneOf(address);
  const space = pane && spaceOfTab(pane.tab);
  if (!space) return false;
  run("space.select", { id: space.id });
  run("tab.select", { id: pane.tab });
  return true;
}
// Gives the chat's terminal a tab in the "channels" space. A space made for it starts with a
// shell tab, closed once the chat's tab is there (the sidebar's timer finishes the job).
// `stale` is the tab of a chat that ended, closed once the new chat's tab is there.
let placing = []; // { address, shell: the tab to close, or "?" until it is known, stale, until }
function placeChat(address, stale = null) {
  const space = holdSpace(ON);
  if (space) run("space.select", { id: space.id });
  else run("space.new", { name: HOLD, folder: PROJECTS, ...(ON ? { machine: ON } : {}) });
  run("terminal.keep", { terminal: address, place: "tab" });
  placing.push({ address, shell: space ? null : "?", stale, until: Date.now() + 8000, kept: Date.now() });
}
const closeTab = (id, keep) => { if (id && id !== keep && spaceOfTab(id)) run("tab.close", { id, confirmed: true }); };
function settlePlacing() {
  placing = placing.filter((p) => {
    const pane = paneOf(p.address);
    if (!pane) {
      // A terminal just started on another machine may not be known here yet ("no running terminal"): ask again.
      if (ON && Date.now() - p.kept > 1500) {
        p.kept = Date.now();
        const space = holdSpace(ON);
        if (space) { run("space.select", { id: space.id }); run("terminal.keep", { terminal: p.address, place: "tab" }); }
      }
      return Date.now() < p.until;
    }
    if (p.shell === "?") p.shell = holdSpace(ON)?.tabs.find((x) => x.id !== pane.tab && x.id !== p.stale)?.id ?? null;
    closeTab(p.shell, pane.tab);
    closeTab(p.stale, pane.tab);
    run("tab.select", { id: pane.tab });
    return false;
  });
}
// What `hc get --json` says of a terminal, with the last line it printed when it has ended; null when
// herdr-core doesn't know it.
async function lastOf(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  try {
    const info = JSON.parse(r.stdout);
    if (info.state !== "live") info.last = lastLine((await hc(["read", address])).stdout);
    return info;
  } catch { return null; }
}

// Opens a channel: shows its chat, starting it when it isn't running. A chat ends with /exit or a crash, or
// herdr-core loses it (an update or restart of the core) and shows a shell under its address. `channels chat
// --bg` starts it again on the same session, and its new tab takes the old one's place. `auto` is the
// sidebar's timer putting the chat back on its own: it leaves a chat that stopped right after it started
// (see afterEnd) down, with a message, until the channel is opened by hand.
// Channels whose chat terminal is being found or started: id -> when. An entry older than a minute is
// forgotten: its work went with the view that ran it.
const finding = new Map();
const findingNow = (id) => finding.has(id) && Date.now() - finding.get(id) < 60000;
// A retry asked for by a view that goes away as the chat comes back (the main area's placeholder): the
// sidebar, which lives as long as the layout, carries it out.
const RETRY = K("retry"); // { channel, at }
function openChannel(c, { auto = false } = {}) {
  const leaving = current()?.name !== c.name;
  if (inSpace()) leaveSpace(); // back from a Herdr space to the channel
  setShared(CURRENT, c.name);
  if (leaving) followPanel(c);
  if (!has("chat-bg")) return openChatTab(c, { auto });
  const was = chatAddress(c);
  if (chatAlive(termOf(was)) && selectChat(was)) { if (downOf(c)) setDown(c, null); return; }
  const old = oldChatTab(c);
  if (old) { run("space.select", { id: holdSpace(ON).id }); run("tab.select", { id: old.id }); return; }
  if (downOf(c)) { if (auto) return; setDown(c, null); }
  if (findingNow(c.id)) return;
  finding.set(c.id, Date.now());
  (async () => {
    // The tab still showing the chat that ended, if one is (an earlier version's tab whose chat ended too): closed once
    // the new chat has its own.
    const stale = paneOf(was)?.tab ?? oldChatTab(c, { dead: true })?.id ?? null;
    if (was && !chatAlive(termOf(was))) {
      const info = await lastOf(was);
      const next = afterEnd(info, { auto, channel: c.name });
      if (!next.start) return setDown(c, { message: next.message, last: info?.last || null, at: Date.now() });
    }
    const address = hereAddress(JSON.parse(await store('channels chat "$1" --bg --json', [c.name], 40000)).address);
    setShared(CHATS, { ...(shared(CHATS) ?? {}), [c.id]: address });
    // Only if the user is still on this channel: a slow start mustn't pull them back.
    if (current()?.name !== c.name) closeTab(stale, paneOf(address)?.tab);
    else if (selectChat(address)) closeTab(stale, paneOf(address)?.tab);
    else placeChat(address, stale);
  })().catch((err) => fail(`Couldn't open #${c.name}'s chat: ${String(err?.message ?? err)}`))
    .finally(() => finding.delete(c.id));
}

// A store whose command can't start a chat in the background: the chat is a tab, named
// "#<channel id>", in the "channels" space on the store's machine, running `<command> chat <name>` in the
// foreground there. Herdr starts it, so it shows on this screen; a rename keeps it, since the tab is keyed by id. A
// tab whose program has ended (only a shell is left: /exit, a crash) is replaced, so the chat starts again on its
// session, unless it ended within seconds of starting: then it waits, with the reason, for a click (see afterEnd).
const tabStarted = new Map(); // channel id -> when this copy last started its chat's tab
const chatTab = (c) => { const space = holdSpace(ON); const tab = tabOf(space, chatOf(c)); return tab ? { space, tab } : null; };
const tabDead = (tab) => panes().some((p) => p.tab === tab.id && p.program?.shell);
function openChatTab(c, { auto }) {
  const hit = chatTab(c);
  if (hit && !tabDead(hit.tab)) {
    run("space.select", { id: hit.space.id });
    run("tab.select", { id: hit.tab.id });
    if (downOf(c)) setDown(c, null);
    return;
  }
  if (downOf(c)) { if (auto) return; setDown(c, null); }
  const started = tabStarted.get(c.id);
  // A tab asked for a moment ago may not be there yet (another machine answers in its own time): one at a time.
  if (!hit && started && Date.now() - started < 8000) return;
  if (hit && auto && started && Date.now() - started < QUICK_MS) {
    const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
    return setDown(c, { message: `#${c.name}'s chat stopped ${secs}s after it started.`, last: null, at: Date.now() });
  }
  tabStarted.set(c.id, Date.now());
  const argv = [...BACKEND.command, "chat", c.name];
  const name = shortId(chatOf(c));
  if (!hit?.space && !holdSpace(ON)) return run("space.new", { name: HOLD, machine: ON ?? "", folder: PROJECTS, tab: name, argv });
  const space = hit?.space ?? holdSpace(ON);
  run("space.select", { id: space.id });
  run("tab.new", { space: space.id, name, folder: PROJECTS, argv });
  if (hit) run("tab.close", { id: hit.tab.id, confirmed: true });
}

const isShown = (task) => shared(TASK) === task.id;

// Whether the main area is showing this channel's chat. The main area is herdr's shown tab, which
// every layout shares: another layout, or a key, can leave something else there.
function chatShown(c) {
  const space = spaces().find((p) => p.active);
  if (!has("chat-bg")) {
    const hit = chatTab(c);
    return Boolean(hit && space?.id === hit.space.id && hit.tab.active && !tabDead(hit.tab));
  }
  if (!space || space.name !== HOLD || (space.machine ?? null) !== ON) return false;
  const tab = space.tabs.find((x) => x.active);
  if (!tab) return false;
  const pane = paneOf(chatAddress(c));
  // A tab still showing a chat that ended (or the shell herdr-core put in its place) isn't the chat.
  if (pane) return pane.tab === tab.id && chatAlive(termOf(chatAddress(c)));
  return Boolean(oldChatTab(c)?.active);
}

// The selected channel: the one clicked last, else the one whose task is on screen, else the first.
function current() {
  const all = channels();
  return all.find((c) => c.name === shared(CURRENT)) ?? all.find((c) => liveTasks(c).some(isShown)) ?? all[0] ?? null;
}

const ask = (dialog, channel, width, height) => openOverlay({ mod: MOD, kind: "dialog", width, height, props: { dialog, channel } });
const DIALOGS = { new: [520, 250], rename: [460, 220], instructions: [620, 470], icon: [560, 560], routines: [640, 640], archive: [440, 190] };
const openDialog = (dialog, channel) => ask(dialog, channel, ...DIALOGS[dialog]);
// A task's menu (Rename, Open on claude.ai when it has a link, Resolve) opens at the pointer; its Rename dialog looks
// like a channel's.
const findTask = (id) => channels().flatMap((c) => c.tasks ?? []).find((x) => x.id === id) ?? null;
// The menu's items above its line (Rename, Send, Open on claude.ai) and below it (Resolve), as render_taskmenu draws them.
const menuTop = (task) => (has("rename-task") ? 1 : 0) + (isCloud(task) && !task.dismissed ? 1 : 0) + (remoteLink(task) ? 1 : 0);
const menuItems = (task) => menuTop(task) + (task.dismissed ? 0 : 1);
const taskMenu = (task) => menuItems(task) && openOverlay({ mod: MOD, kind: "popup", width: remoteLink(task) ? 200 : 180, height: 10 + 34 * menuItems(task) + (menuTop(task) && !task.dismissed ? 9 : 0), props: { taskmenu: task.id } });
const sendTask = (task) => openOverlay({ mod: MOD, kind: "dialog", width: 460, height: 300, props: { dialog: "send-task", task: task.id } });
const renameTask = (task) => openOverlay({ mod: MOD, kind: "dialog", width: 460, height: 240, props: { dialog: "rename-task", task: task.id } });
const resolveTask = (id) => {
  const task = findTask(id);
  submit((all) => eachTask(all, id, (x) => { x.dismissed = true; x.dismissed_at = new Date().toISOString(); x.dismissed_by = BY; }),
    'channels dismiss "$1" --by "$2"', [id, BY], `resolve ${task?.name || "the task"}`);
  if (isCloud(task)) archiveNote(task);
};
// Resolving a cloud task here doesn't touch the session, which stays on claude.ai until it is archived there.
const archiveNote = (task) => note(`${task?.name || "The cloud task"} is resolved here. It stays on claude.ai: archive it there (··· → Archive).`);
const TASK_NAME = 80; // the longest task name `channels rename-task` takes

// ---------- routines: helpers for the dialog ----------

// A row drawn collapsed this frame opens on the next: the dialog draws again a moment later.
const cx_settle = (view) => { view.settleR = true; };

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // the order the day buttons show, Monday first
const PRESETS = [["weekdays", "Weekdays", 86], ["daily", "Daily", 62], ["hourly", "Hourly", 66], ["weekly", "Weekly", 70], ["cron", "Cron", 56]];
const CATCHUP = [[0, "Don't", 62], [15, "15 min", 66], [60, "1 hour", 66], [240, "4 hours", 72], [1440, "1 day", 58]];
const pad2 = (n) => `${n}`.padStart(2, "0");

// A routine's stored schedule ("weekdays 09:00", "cron 0 9 * * 1-5") as the dialog's fields.
function scheduleFields(spec) {
  const f = { preset: "weekdays", time: "09:00", minute: "00", day: 1, cron: "0 9 * * 1-5" };
  let m;
  if ((m = /^(weekdays|daily) (\d\d:\d\d)$/.exec(spec ?? ""))) Object.assign(f, { preset: m[1], time: m[2] });
  else if ((m = /^hourly :(\d\d)$/.exec(spec ?? ""))) Object.assign(f, { preset: "hourly", minute: m[1] });
  else if ((m = /^weekly ([a-z]{3}) (\d\d:\d\d)$/.exec(spec ?? ""))) Object.assign(f, { preset: "weekly", day: Math.max(0, DAYS.indexOf(m[1])), time: m[2] });
  else if ((m = /^cron (.+)$/.exec(spec ?? ""))) Object.assign(f, { preset: "cron", cron: m[1] });
  return f;
}

// "Today 09:00", "Tomorrow 09:00", "Fri 16:00", "Nov 20, 16:00".
function whenText(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Tomorrow ${hm}`;
  if (diff === -1) return `Yesterday ${hm}`;
  if (Math.abs(diff) < 6) return `${DAY_LABELS[d.getDay()]} ${hm}`;
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}, ${hm}`;
}

// A routine's last run in a few words, and the colour to say it in.
function lastRun(r, t) {
  const l = r.last;
  if (!l) return ["never run", t.dim];
  if (l.status === "missed") return [`missed ${whenText(l.due_at)}`, t.blocked];
  const at = whenText(l.kind === "manual" ? l.at : l.due_at);
  const late = l.kind !== "manual" && l.late_min > 2 ? ` · late, ran ${whenText(l.at).replace(/^Today /, "")}` : "";
  const waiting = l.status === "queued" ? " · waiting for the chat" : "";
  return [`${l.kind === "manual" ? "run now " : ""}${at}${late}${waiting}`, l.status === "queued" ? t.working : t.muted];
}

export default class Channels extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.dialog ? "dialog" : p.menu ? "menu" : p.taskmenu ? "taskmenu" : p.head ? "head" : p.foot ? "foot" : p.taskhead ? "taskhead" : p.panel ? "panel" : p.bar ? "bar" : p.down ? "down" : "sidebar";
    this.hover = null;
    this.drag = null; // the channel row being held, see dragMove
    this.handle = cx.focus_handle();
    if (this.role === "dialog") return this.initDialog(cx);
    if (this.role === "panel") {
      this.tab = "active";
      this.pending = [];
      this.visible = []; // the tasks on screen, top to bottom, for the arrow keys
      this.cursor = null; // the id of the task the arrow keys are on
      this.leaving = new Set(); // tasks collapsing out of the list
      this.known = { channel: null, ids: new Set() }; // rows already drawn: a new one grows in
      this.settle = false; // a row was drawn collapsed this frame; draw again so it opens
      this.arrived = true; // false for one frame when the list comes back, so it fades and slides in
      this.listFocus = shared(LIST_FOCUS) ?? null;
      // The list wants the keyboard from the moment it comes back. herdr hands the keyboard to
      // the chat a moment after the task's terminal leaves the screen, and a hover under the
      // pointer shifts when that lands, so asking once isn't enough: hold on for a short while,
      // and again briefly after each hover, then let go so a click elsewhere keeps the keyboard.
      this.keys = { want: false, since: 0, hoverAt: 0 };
      cx.timer.every(25, (cx) => {
        const now = Date.now();
        const stamp = shared(LIST_FOCUS) ?? null;
        if (stamp !== this.listFocus) {
          this.listFocus = stamp;
          this.cursor = shared(LAST_TASK) ?? this.cursor;
          this.keys = { want: true, since: now, hoverAt: 0 };
          this.arrived = false;
          this.handle.focus();
          return cx.notify();
        }
        if (!this.arrived || this.settle) { this.arrived = true; this.settle = false; cx.notify(); }
        if (!this.keys.want || shared(TASK) || this.handle.is_focused()) return;
        if (now - this.keys.since < 700 || now - this.keys.hoverAt < 300) this.handle.focus();
        else this.keys.want = false;
      });
    }
    if (this.role === "taskhead") {
      // Leaving the session (left arrow on an empty prompt) changes its terminal's mark: go back
      // to the task list. The first mark seen for a terminal is where it stood when it was opened.
      this.mark = { address: null, value: null };
      this.focus = { opened: null, tries: 0 };
      this.arrived = true;
      cx.timer.every(25, (cx) => {
        const address = shared(TASK_TERM);
        if (!address || !shared(TASK)) return;
        // Opening a task puts the keyboard in its prompt. The terminal's block may not be on
        // screen the instant the layout changes, so ask again for the first few ticks.
        const opened = shared(OPENED);
        if (opened !== this.focus.opened) { this.focus = { opened, tries: 3 }; this.arrived = false; cx.notify(); }
        else if (!this.arrived) { this.arrived = true; cx.notify(); }
        if (this.focus.tries > 0) { this.focus.tries -= 1; run("pane.focus", { terminal: address }); }
        const value = terminals().find((x) => x.address === address)?.labels?.[BACK] ?? null;
        if (this.mark.address !== address) this.mark = { address, value };
        else if (value !== this.mark.value) { this.mark.value = value; showTasks(); }
      });
    }
    if (this.role !== "sidebar") return;

    this.tick = shared(TICK) ?? 0;
    this.knownChannels = null; // channels already drawn: a new one fades in
    this.settle = false;
    this.draining = false;
    this.retryAt = shared(RETRY)?.at ?? null; // a retry left from before the app started isn't carried out
    setShared(BUSY, false);
    cx.timer.every(40, (cx) => {
      if (this.settle) { this.settle = false; cx.notify(); }
      if (placing.length) settlePlacing();
      if (shared("layout") === LAYOUT) followSpaces();
      const retry = shared(RETRY);
      if (retry && retry.at !== this.retryAt) {
        this.retryAt = retry.at;
        const c = channels().find((x) => x.name === retry.channel);
        if (c) openChannel(c);
      }
      this.drain(cx);
    });
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.restoredAt = 0;
    cx.timer.every(1000, (cx) => {
      const now = shared(TICK) ?? 0;
      if (now !== this.tick) { this.tick = now; this.refresh(cx); }
      // Put the selected channel's chat back if the main area is showing anything else, or if the
      // chat ended (/exit): it starts again. Not while a Herdr space is selected in the sidebar
      // (Herdr showing another space selects it there: see followSpaces). Not more than once every
      // few seconds: a chat's tab takes a moment to appear the first time.
      const here = current();
      syncMain();
      syncSpaceUi();
      if (here && shared("layout") === LAYOUT && !inSpace() && !downOf(here) && !chatShown(here) && Date.now() - this.restoredAt > 4000) {
        this.restoredAt = Date.now();
        openChannel(here, { auto: true });
      }
    });
    // For keys: channels.next / .prev walk the channels; .new-channel opens the dialog.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const all = channels();
        if ((c === "next" || c === "prev") && all.length) {
          const at = all.findIndex((ch) => ch.name === current()?.name);
          openChannel(all[(at + (c === "next" ? 1 : -1) + all.length) % all.length]);
        } else if (c === "new-channel") openDialog("new", null);
        // channels.task-next / .task-prev open the selected channel's next task in the panel;
        // channels.tasks goes back to the list.
        else if (c === "task-next" || c === "task-prev") {
          const list = liveTasks(current()).filter((x) => herdrMachine(x) !== undefined && (!isCloud(x) || cloudAttach()));
          const at = list.findIndex(isShown);
          if (list.length) openTask(list[(at + (c === "task-next" ? 1 : -1) + list.length) % list.length]).catch(() => {});
        } else if (c === "tasks") showTasks();
        // channels.rename-task: the Rename dialog for the task open in the panel.
        else if (c === "rename-task" && has("rename-task")) { const task = findTask(shared(TASK)); if (task) renameTask(task); }
        // channels.open-task: a task card's Open, in the chat's Claude Code (see openRequested).
        else if (c === "open-task") openRequested(cx, () => this.refresh(cx)).catch((err) => fail(`Couldn't open the task: ${String(err?.message ?? err)}`));
        // channels.rename / .instructions / .icon / .archive: that dialog for the selected channel.
        else if (DIALOGS[c] && c !== "new" && (c !== "routines" || has("routines")) && current()) openDialog(c, current().name);
        cx.notify();
      }
    });
  }

  refresh(cx) {
    cx.spawn(async () => {
      try { await askFeatures(); } catch { /* asked again later */ }
      try { await lookForRelease(); } catch { /* looked again later */ }
      const started = Date.now();
      let next;
      try { next = { ...(await readStore()), error: null, at: Date.now() }; }
      catch (err) { next = { machine: shared(DATA)?.machine ?? null, features: shared(DATA)?.features, remote: shared(DATA)?.remote ?? false, cloud: shared(DATA)?.cloud ?? null, updates: shared(DATA)?.updates ?? null, channels: shared(DATA)?.channels ?? [], error: String(err?.message ?? err), at: Date.now() }; }
      // Something changed here while this read was out: what it brought back is older.
      if (shared(BUSY) || (shared(OP_AT) ?? 0) > started) return;
      setShared(DATA, next);
    });
  }

  // Carries out the queued commands in order, then reads the store again. A command queued more
  // than a minute ago (the app was closed with it waiting) is dropped.
  drain(cx) {
    if (this.draining || !(shared(OPS) ?? []).length) return;
    this.draining = true;
    setShared(BUSY, true);
    cx.spawn(async (cx) => {
      for (;;) {
        const [op, ...rest] = shared(OPS) ?? [];
        if (!op) break;
        setShared(OPS, rest);
        if (Date.now() - op.at > 60000) continue;
        try { await store(op.script, op.args); }
        catch (err) { fail(`Couldn't ${op.what}: ${String(err?.message ?? err)}`); }
      }
      this.draining = false;
      setShared(BUSY, false);
      setShared(OP_AT, Date.now());
      this.refresh(cx);
    });
  }

  hovering(key) {
    return (hovered, cx) => {
      this.hover = hovered ? key : this.hover === key ? null : this.hover;
      if (this.keys) this.keys.hoverAt = Date.now();
      cx.notify();
    };
  }

  // A small square button holding an icon or a glyph.
  tool(id, what, action, t) {
    return div().id(id).w(24).h(24).rounded(6).flex().items_center().justify_center()
      .text_size(14).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action).child(what);
  }

  // Which machine something runs on: a small icon and its name.
  where(machine, t) {
    return h_flex().gap(5).items_center().text_size(12).text_color(t.dim)
      .child(svg(ICON(machine === "cloud" ? "cloud" : machine === localName() ? "monitor" : "server")).size(12)).child(machine ?? "");
  }

  render() {
    return this[`render_${this.role}`]();
  }

  // ---------- the strip above the sidebar: the window's buttons sit here, and it drags the window ----------

  render_head() {
    const t = theme();
    // macOS draws its window buttons over the left of this strip; the name starts clear of them.
    return h_flex().size_full().pl(window()?.platform === "macos" ? 84 : 18).pr(12).items_center().bg(t.chrome)
      .border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.muted).child("herdr"));
  }

  // ---------- the sidebar: channels ----------

  // Moves a channel to a place in the list (0 is the top). It moves at once; the store follows.
  move(name, to) {
    const list = channels();
    const from = list.findIndex((c) => c.name === name);
    if (from === -1 || from === to) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setShared(ORDER, next.map((c) => c.id ?? c.name));
    if (moved.position == null) return; // a store that keeps no order: this computer's order is all there is
    const order = next.map((c) => c.name);
    submit((all) => { for (const c of all) c.position = order.indexOf(c.name) + 1; },
      'channels move "$1" "$2"', [name, String(to + 1)], `move ${name}`);
  }

  // Dragging a channel, the way a list reorders on macOS: the held row lifts and follows the
  // pointer, the others slide apart to show where it will land, and on release it settles there.
  // this.drag is { name, from, grab, top, start, moved } while a row is held; `moved` turns true
  // once the pointer has travelled a few pixels, so a plain click still opens the channel.
  dragMove(e, n, cx) {
    const d = this.drag;
    const y = e.local_position?.y;
    if (!d || y == null) return;
    d.start ??= y;
    if (!d.moved && Math.abs(y - d.start) < 4) return;
    d.moved = true;
    d.top = Math.max(-10, Math.min((n - 1) * ROW + 10, y - d.grab - 2));
    cx.notify();
  }

  dragEnd(list, target, cx) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved) { const c = list.find((x) => x.name === d.name); if (c) openChannel(c); }
    else if (target !== -1 && target !== d.from) this.move(d.name, target);
    cx.notify();
  }

  render_sidebar() {
    const t = theme();
    const data = shared(DATA);
    const here = current();
    const menu = (c) => openOverlay({ mod: MOD, kind: "popup", width: 200, height: has("routines") ? 190 : 156, props: { menu: c.name } });
    const list = channels();
    const drag = this.drag?.moved ? this.drag : null;
    const fresh = new Set(this.knownChannels ? list.filter((c) => !this.knownChannels.has(c.name)).map((c) => c.name) : []);
    this.knownChannels = new Set(list.map((c) => c.name));
    if (fresh.size) this.settle = true;
    const failed = shared(FAIL);
    // The slot the held row would land in, and where every other row sits to leave it open.
    const target = drag ? Math.max(0, Math.min(list.length - 1, Math.round(drag.top / ROW))) : -1;
    const slot = (i) => {
      if (!drag) return i;
      if (i === drag.from) return target;
      if (drag.from < target && i > drag.from && i <= target) return i - 1;
      if (drag.from > target && i >= target && i < drag.from) return i + 1;
      return i;
    };

    const row = (c, i) => {
      const key = `c:${c.name}`;
      const selected = here?.name === c.name && !inSpace();
      const lifted = drag?.name === c.name;
      return h_flex().id(`ch-${c.name}`).absolute().left(0).right(0).h(ROW).pl(8).pr(8).items_center()
        .top(lifted ? drag.top : slot(i) * ROW)
        .opacity(fresh.has(c.name) ? 0 : 1).transition("opacity", 220)
        // The held row tracks the pointer almost at once; the rest glide, and so does the drop.
        .spring("top", lifted ? { response: 45, damping: 1 } : { response: 280, damping: 0.82 })
        // The connector: a line down from the heading that turns right into the row. It fades
        // while its row is lifted off the list.
        .child(div().w(22).h(ROW).opacity(lifted ? 0 : 1).transition("opacity", 140)
          .child(div().ml(10).w(10).h(18).border_l(1).border_b(1).rounded_bl(5).border_color(t.dim).opacity(0.55)))
        .child(h_flex().id(`ch-row-${c.name}`).flex_1().min_w(0).h(36).px(10).gap(10).items_center().rounded(8).border_1()
          .border_color(lifted ? t.border : "#00000000")
          .when(selected && !lifted, (el) => el.bg(t.selected))
          .when(lifted, (el) => el.bg(t.raised).shadow_lg().cursor_grabbing())
          .when(!drag, (el) => el.cursor_pointer().hover((st) => st.bg(selected ? t.selected : t.hover)))
          .on_hover(this.hovering(key))
          .on_mouse_down("left", (e) => { this.drag = { name: c.name, from: i, grab: e.local_position?.y ?? 18, top: i * ROW, start: null, moved: false }; })
          .on_mouse_down("right", () => menu(c))
          .child(div().w(20).flex_none().text_size(15).child(iconOf(c)))
          .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(selected || lifted ? t.foreground : t.muted).child(c.name))
          // A small clock while the channel has a routine switched on.
          .child(div().id(`ch-clock-${c.name}`).flex_none().w(active(c) ? 14 : 0).h(14).overflow_hidden().opacity(active(c) ? 1 : 0)
            .transition("opacity", 180).transition("width", 180)
            .child(svg(ICON("clock")).size(13).text_color(selected ? t.muted : t.dim)))
          .when(!drag && (this.hover === key || selected), (el) => el.child(this.tool(`ch-more-${c.name}`, "···", () => menu(c), t))));
    };
    // The held row is drawn last, so it passes over the others.
    const rows = list.map(row);
    if (drag) rows.push(...rows.splice(drag.from, 1));

    return v_flex().size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().px(18).pt(8).pb(8).gap(10).items_center()
        .child(svg(ICON("layers")).size(16).text_color(t.accent))
        .child(div().flex_1().text_size(14).font_medium().child("Channels")))
      .when(Boolean(data?.error), (el) => el.child(div().px(18).py(4).text_size(12).text_color(t.blocked).child(data.error)))
      .when(!data, (el) => el.child(div().px(18).py(4).text_size(12).text_color(t.dim).child("Loading channels…")))
      .when(Boolean(failed) && Date.now() - failed.at < 12000, (el) => el.child(div().px(18).py(4).text_size(12).text_color(t.blocked).child(failed?.message ?? "")))
      .child(v_flex().id("ch-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(drag), (el) => el.cursor_grabbing())
        .on_mouse_move((e, cx) => this.dragMove(e, list.length, cx))
        .on_mouse_up("left", (_e, cx) => this.dragEnd(list, target, cx))
        // Leaving the list with a row in hand puts it back.
        .on_hover((hovered, cx) => { if (!hovered && this.drag) { this.drag = null; cx.notify(); } })
        .child(div().id("ch-track").relative().w_full().flex_none().h(list.length * ROW).transition("height", 180).children(rows))
        .child(h_flex().id("ch-new").ml(30).mr(8).mt(4).h(36).flex_none().px(10).gap(10).items_center().rounded(8).cursor_pointer()
          .text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => openDialog("new", null))
          .child(svg(ICON("plus")).size(14))
          .child(div().text_size(14).child("New channel"))))
      .child(this.releaseRow(t, data))
      .child(this.refreshRow(t, data));
  }

  // The sidebar's foot, its own block under Herdr's spaces list.
  render_foot() {
    const t = theme();
    return v_flex().size_full().justify_end().bg(t.chrome).text_color(t.foreground).child(this.footer(t, shared(DATA)));
  }

  // Above the footer, only while something is stale: a chat runs an older Claude Code or herdr-channels than is
  // installed. Refresh restarts the idle ones now and the rest as their turns end; then the row says what it did.
  refreshRow(t, data) {
    const running = Boolean(shared(REFRESHING)) && Date.now() - shared(REFRESHING) < 600000;
    const done = shared(REFRESHED);
    const recent = Boolean(done) && Date.now() - done.at < 12000;
    const row = running ? { offer: false, title: "Refreshing…", detail: "Each chat restarts once it's idle." }
      : recent ? { offer: false, title: done.failed ? "Refresh failed" : "Refreshed", detail: done.message }
      : refreshRow(data?.updates);
    if (!row) return div();
    const color = recent && done.failed ? t.blocked : row.offer || running || recent ? t.accent : t.dim;
    return h_flex().id("refresh-row").mx(10).mb(10).px(12).py(10).gap(10).items_start().flex_none().rounded(10)
      .border_1().border_color(t.border).bg(t.background)
      .child(running ? svg(ICON("spinner")).size(15).mt(1).flex_none().text_color(color).spin(900)
        : svg(ICON("rotate-cw")).size(15).mt(1).flex_none().text_color(color))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(12.5).text_color(t.foreground).child(row.title))
        .child(div().text_size(11.5).text_color(t.muted).child(row.detail)))
      .when(row.offer, (el) => el.child(div().id("refresh-go").h(26).px(10).flex().flex_none().items_center().rounded(7)
        .bg(t.accent).text_color(t.background).text_size(12.5).font_medium().cursor_pointer().hover((st) => st.opacity(0.85))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { refreshNow().finally(() => cx.notify()); cx.notify(); })
        .child("Refresh")));
  }

  // Above the refresh row, only while a newer herdr-channels release is out (the tick looks every few hours) or an
  // update runs. Nothing updates until Update is clicked.
  releaseRow(t, data) {
    if (!has("update")) return div();
    const release = releaseNow();
    const clicked = pendingClick();
    const row = clicked ? { state: "running", title: `Updating to ${release?.latest ?? "the latest release"}…`, detail: "Starting.", button: null, notes: null } : releaseRow(release, Date.now(), { remote: Boolean(ON) });
    if (!row) return div();
    const color = row.state === "failed" ? t.blocked : row.state === "done" ? t.ansi2 : t.accent;
    return h_flex().id("release-row").mx(10).mb(10).px(12).py(10).gap(10).items_start().flex_none().rounded(10)
      .border_1().border_color(t.border).bg(t.background)
      .child(row.state === "running" ? svg(ICON("spinner")).size(15).mt(1).flex_none().text_color(color).spin(900)
        : svg(ICON(row.state === "done" ? "circle-check" : "download")).size(15).mt(1).flex_none().text_color(color))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(12.5).text_color(t.foreground).child(row.title))
        .child(div().text_size(11.5).text_color(t.muted).child(row.detail))
        .when(Boolean(row.notes), (el) => el.child(div().id("release-notes").text_size(11.5).text_color(t.accent).cursor_pointer()
          .hover((st) => st.opacity(0.8))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => { openNotes(row.notes); })
          .child("Release notes"))))
      .when(Boolean(row.button), (el) => el.child(div().id("release-go").h(26).px(10).flex().flex_none().items_center().rounded(7)
        .bg(t.accent).text_color(t.background).text_size(12.5).font_medium().cursor_pointer().hover((st) => st.opacity(0.85))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { updateNow().finally(() => cx.notify()); cx.notify(); })
        .child(row.button)));
  }

  // The foot of the sidebar: this machine, which holds the channels, and whether the store answers.
  // A store on another machine: that machine, and whether Herdr reaches it now.
  footer(t, data) {
    const link = ON ? B.linkState(BACKEND, machines(), data?.error) : null;
    const [color, text] = ON
      ? { connected: [t.ansi2, "connected"], connecting: [t.dim, "connecting…"], unreachable: [t.blocked, "unreachable"], unreadable: [t.blocked, "store unreadable"] }[link]
      : data?.error ? [t.blocked, "store unreadable"] : data ? [t.ansi2, "on this Mac"] : [t.dim, "reading…"];
    return h_flex().h(44).flex_none().px(18).gap(10).items_center().border_t(1).border_color(t.border)
      // flex_none: a long host name plus the version label would otherwise squeeze the dot into an oval.
      .child(div().w(8).h(8).flex_none().rounded(4).bg(color))
      .child(svg(ICON(ON ? "server" : "monitor")).size(13).flex_none().text_color(t.muted))
      .child(div().min_w(0).truncate().text_size(13).text_color(t.muted).child(ON ?? data?.machine ?? "this Mac"))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(text))
      // This herdr-channels install's version (install.mjs writes it into config.js).
      .when(Boolean(versionLabel(CONFIG.version)), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(versionLabel(CONFIG.version))));
  }

  // ---------- the main area, while the channel's chat is down ----------

  // A chat that stopped right after it started isn't started again on its own (see openChannel):
  // this stands in for it, says why, and retries on a click.
  render_down() {
    const t = theme();
    const here = current();
    const down = downOf(here);
    return v_flex().size_full().items_center().justify_center().gap(10).px(32).bg(t.background).text_color(t.foreground)
      .child(div().text_size(28).child(iconOf(here)))
      .child(div().text_size(16).font_medium().child(here ? `#${here.name}'s chat failed to start` : "The chat failed to start"))
      .when(Boolean(down?.message), (el) => el.child(div().max_w(560).text_size(13).text_color(t.muted)
        .child(down.message.replace(/^#\S+'s chat s/, "S"))))
      .when(Boolean(down?.last), (el) => el.child(div().max_w(560).px(12).py(8).rounded(8).bg(t.raised)
        .text_size(12.5).text_color(t.blocked).child(down.last)))
      .child(div().id("down-retry").mt(6).px(14).h(32).flex().items_center().rounded(8).text_size(13.5)
        .border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { if (here) setShared(RETRY, { channel: here.name, at: Date.now() }); }).child("Retry"))
      .child(div().text_size(12).text_color(t.dim).child("Selecting the channel tries again too."));
  }

  // ---------- the bar above the main area ----------

  render_bar() {
    const t = theme();
    const here = current();
    return h_flex().size_full().px(16).gap(8).items_center().bg(t.background).border_b(1).border_color(t.border).text_color(t.foreground)
      .when(Boolean(here), (el) => el
        .child(div().text_size(15).child(iconOf(here)))
        .child(div().id("bar-channel").text_size(14).font_medium().cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => openChannel(here)).child(here.name)))
      .child(div().flex_1())
      .when(Boolean(here) && Boolean(storeName()), (el) => el.child(this.where(storeName(), t)))
      .child(this.tool("bar-tasks", svg(ICON("panel-right")).size(16), () => run("layout.toggle", { id: TASKS_PANEL }), t)
        .when(!find(layout(), TASKS_PANEL)?.hidden, (el) => el.bg(t.selected).text_color(t.foreground)));
  }

  // ---------- the tasks panel ----------

  // A fresh Claude Code session in the projects folder: a background session with no prompt yet.
  // Its row appears at once and the session opens as soon as Claude Code has made it. `claude
  // --bg` picks the session's id itself, so it is filed by its job.
  startFresh(channel, cx) {
    const id = uuid();
    const task = { id: `pending/${id}`, machine: storeName(), session_id: id, job: null, name: FRESH, folder: PROJECTS, standing: "needs", added_at: new Date().toISOString() };
    this.pending.push({ channel, task });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // `claude --bg` prints the commands for the new session; the id they name is its job.
        // With Remote Control on it shows at claude.ai/code too, titled from its first message.
        const out = await store(`cd "$1" && claude --bg${remoteOn() ? " --remote-control" : ""} 2>&1`, [PROJECTS], 60000);
        task.job = out.match(/claude attach (\S+)/)?.[1] ?? null;
        if (!task.job) throw new Error(out.trim().split("\n").pop() || "claude --bg gave no session");
        await openTask(task, { channel: channels().find((c) => c.name === channel) ?? { name: channel } });
        await store('channels file "$1" "$2" --name "$3" --folder "$4"', [channel, task.job, FRESH, PROJECTS]);
        this.failed = null;
      } catch (err) {
        this.failed = `Couldn't start a session in ${channel}: ${String(err?.message ?? err)}`;
      }
      this.pending = this.pending.filter((p) => p.task.id !== task.id);
      changed();
      cx.notify();
    });
  }

  open(task, cx) {
    this.keys.want = false;
    // Opening a task is seeing its events: its unread dot goes, and the store follows.
    if (task.unread && has("seen")) submit((all) => eachTask(all, task.id, (x) => { x.unread = null; }), 'channels seen "$1"', [task.id], `mark ${task.name || "the task"} seen`);
    cx.spawn(async (cx) => {
      try { await openTask(task); this.failed = null; } catch (err) { this.failed = String(err?.message ?? err); }
      cx.notify();
    });
  }

  // Up and down move through the tasks, right or enter opens the one the cursor is on.
  listKey(e, cx) {
    const list = this.visible;
    const at = list.findIndex((x) => x.id === this.cursor);
    if (e.key === "down") this.cursor = list[Math.min(list.length - 1, at + 1)]?.id ?? null;
    else if (e.key === "up") this.cursor = list[Math.max(0, at === -1 ? 0 : at - 1)]?.id ?? null;
    else if ((e.key === "right" || e.key === "enter") && at !== -1 && herdrMachine(list[at]) !== undefined) this.open(list[at], cx);
    else return;
    this.keys.want = true;
    this.keys.since = Date.now();
    cx.stop_propagation();
    cx.notify();
  }

  // Resolving a task: its row closes up, then it moves to Resolved. The store follows.
  resolve(task, cx) {
    const list = this.visible;
    const at = list.findIndex((x) => x.id === task.id);
    if (this.cursor === task.id) this.cursor = (list[at + 1] ?? list[at - 1])?.id ?? null;
    this.leaving.add(task.id);
    cx.notify();
    cx.timer.after(190, (cx) => {
      submit((all) => eachTask(all, task.id, (x) => { x.dismissed = true; x.dismissed_at = new Date().toISOString(); x.dismissed_by = BY; }),
        'channels dismiss "$1" --by "$2"', [task.id, BY], `resolve ${task.name || "the task"}`);
      if (isCloud(task)) archiveNote(task);
      this.leaving.delete(task.id);
      cx.notify();
    });
  }

  render_panel() {
    const t = theme();
    const here = current();
    // A different channel starts on its Active tab, without the last one's error, and with its
    // rows simply there: only a row that turns up later grows in.
    if (this.shownFor !== here?.name) { this.shownFor = here?.name; this.tab = "active"; this.failed = null; this.known = { channel: here?.name, ids: null }; }
    const filed = new Set((here?.tasks ?? []).map((x) => x.id));
    const starting = this.pending.filter((p) => p.channel === here?.name && !filed.has(p.task.id)).map((p) => p.task).reverse();
    const active = [...starting, ...liveTasks(here)];
    const resolved = doneTasks(here);
    const needs = active.filter((x) => x.standing === "needs");
    const working = active.filter((x) => x.standing === "working");
    const ready = active.filter((x) => x.standing !== "needs" && x.standing !== "working");
    const groups = this.tab === "active"
      ? [["Needs input", "needs", needs], ["Working", "working", working], ["Ready for review", "ready", ready]].filter((g) => g[2].length)
      : [[null, "resolved", resolved]].filter((g) => g[2].length);
    this.visible = groups.flatMap((g) => g[2]).filter((x) => !this.leaving.has(x.id));

    const all = groups.flatMap((g) => g[2]).map((x) => x.id);
    const fresh = new Set(this.known.ids ? all.filter((id) => !this.known.ids.has(id)) : []);
    this.known.ids = new Set(all);
    if (fresh.size) this.settle = true;

    // Where each row sits, for the bar that follows the arrow keys.
    const top = {};
    let y = 0;
    for (const [label, , tasks] of groups) {
      if (label) y += GROUP_H;
      for (const x of tasks) { top[x.id] = y; if (!this.leaving.has(x.id)) y += TASK_H; }
    }

    const pill = (id, label) => div().id(`tp-tab-${id}`).px(12).h(30).flex().items_center().rounded(8).text_size(13.5).cursor_pointer()
      .text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (el) => el.bg(t.selected))
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = id; this.known.ids = null; cx.notify(); }).child(label);
    const mark = {
      unknown: () => svg(ICON("cloud-off")).size(15).text_color(t.dim),
      working: () => svg(ICON("spinner")).size(15).text_color(t.working).spin(900),
      needs: () => svg(`mods/${MOD}/needs.svg`).size(15).text_color(t.blocked),
      ready: () => svg(ICON("circle-check")).size(15).text_color(t.muted),
      resolved: () => svg(ICON("check")).size(15).text_color(t.dim),
    };

    const row = (task, kind) => {
      const key = `t:${task.id}`;
      const reachable = herdrMachine(task) !== undefined;
      const closed = this.leaving.has(task.id) || fresh.has(task.id);
      const canResolve = kind !== "resolved" && filed.has(task.id);
      const unread = kind !== "resolved" && Boolean(task.unread) && !isShown(task);
      // A session still starting has no task to rename yet, nor a menu. A store that can't rename a task offers none.
      const canMenu = filed.has(task.id) && menuItems(task) > 0;
      // A cloud task: a cloud glyph after its name, its cost instead of its age, and, when its state can't be known
      // now (the sessions list failed, or cloud tasks are off), a crossed-out cloud and "state unknown".
      const cloud = isCloud(task) ? task.cloud ?? {} : null;
      const unknown = Boolean(cloud?.unknown) && kind !== "resolved";
      const right = kind === "resolved" ? ago(task.dismissed_at) : unknown ? "state unknown" : cloud?.cost_usd != null ? `$${cloud.cost_usd.toFixed(2)}` : ago(task.added_at);
      return h_flex().id(`tk-${task.id}`).mx(8).px(8).gap(12).items_center().rounded(8).overflow_hidden().flex_none()
        .h(closed ? 0 : TASK_H).opacity(closed ? 0 : 1).transition("height", 180).transition("opacity", 150)
        .when(reachable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(task, cx)))
        .when(canMenu, (el) => el.on_mouse_down("right", () => taskMenu(task)))
        .on_hover(this.hovering(key))
        .child(div().w(28).h(28).flex_none().rounded(8).bg(t.raised).flex().items_center().justify_center().child(mark[unknown ? "unknown" : kind]()))
        .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(reachable && !unknown ? t.foreground : t.dim).when(unread, (el) => el.font_medium()).child(task.name || shortId(task)))
        .when(Boolean(cloud), (el) => el.child(svg(ICON("cloud")).size(13).flex_none().text_color(t.dim)))
        // A task with an event not seen yet (it finished, or asked something, since it was last opened) has a dot.
        .when(unread, (el) => el.child(div().id(`tk-new-${task.id}`).w(8).h(8).flex_none().rounded(4).bg(t.accent)))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(right))
        // The menu and resolve buttons keep their place whether or not they show, so hovering moves nothing.
        .child(div().w(24).flex_none().opacity(canMenu && this.hover === key ? 1 : 0).transition("opacity", 120)
          .when(canMenu, (el) => el.child(this.tool(`tk-more-${task.id}`, "···", () => taskMenu(task), t))))
        .when(kind !== "resolved", (el) => el.child(div().w(24).flex_none().opacity(canResolve && this.hover === key ? 1 : 0).transition("opacity", 120)
          .when(canResolve, (e2) => e2.child(this.tool(`tk-done-${task.id}`, svg(ICON("check")).size(14), (_e, cx) => this.resolve(task, cx), t)))));
    };
    const heading = (label, count) => h_flex().h(GROUP_H).flex_none().px(16).pt(10).gap(8).items_center()
      .child(div().text_size(13).text_color(t.muted).child(label))
      .child(div().text_size(13).text_color(t.dim).child(`${count}`));
    const body = groups.flatMap(([label, kind, tasks]) => [
      ...(label ? [heading(label, tasks.filter((x) => !this.leaving.has(x.id)).length)] : []),
      ...tasks.map((x) => row(x, kind)),
    ]);
    const empty = this.tab === "active" ? ["No tasks in this channel", "Press + to start a session."] : ["Nothing resolved yet", "Resolved tasks are kept here."];
    const cursorAt = this.cursor != null && !this.leaving.has(this.cursor) ? top[this.cursor] : undefined;

    return div().id("tp-root").track_focus(this.handle).on_key_down((e, cx) => this.listKey(e, cx)).size_full().bg(t.background)
      // Coming back from a task, the list eases in from the left.
      .child(v_flex().size_full().relative().left(this.arrived ? 0 : -14).opacity(this.arrived ? 1 : 0)
        .transition("left", 200).transition("opacity", 160).text_color(t.foreground)
        .child(h_flex().pl(16).pr(8).h(HEAD).flex_none().gap(4).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().child(here ? `Tasks in #${here.name}` : "Tasks"))
          .when(Boolean(here), (el) => el.child(this.tool("tp-new", svg(ICON("plus")).size(16), (_e, cx) => this.startFresh(here.name, cx), t)))
          .child(this.tool("tp-close", svg(ICON("x")).size(16), () => run("layout.hide", { id: TASKS_PANEL }), t)))
        .child(h_flex().px(8).pt(10).pb(4).flex_none().gap(2).child(pill("active", "Active")).child(pill("resolved", "Resolved")))
        .when(Boolean(this.failed), (el) => el.child(div().px(16).py(4).text_size(12).text_color(t.blocked).child(this.failed)))
        .when(Boolean(shared(NOTE)) && Date.now() - (shared(NOTE)?.at ?? 0) < 12000, (el) => el.child(div().px(16).py(4).text_size(12).text_color(t.muted).child(shared(NOTE)?.message ?? "")))
        .child(div().id("tp-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
          .child(div().relative().w_full()
            // The bar that follows the arrow keys glides between rows instead of jumping.
            .when(cursorAt !== undefined, (el) => el.child(div().absolute().left(8).right(8).h(TASK_H).top(cursorAt).rounded(8).bg(t.hover)
              .spring("top", { response: 150, damping: 0.95 })))
            .child(v_flex().relative().w_full().children(body)))
          .when(body.length === 0, (el) => el.child(v_flex().px(16).pt(28).gap(4).items_center()
            .child(div().text_size(13.5).text_color(t.muted).child(empty[0]))
            .child(div().text_size(12.5).text_color(t.dim).child(empty[1]))))));
  }

  // ---------- the header over a task open in the panel ----------

  render_taskhead() {
    const t = theme();
    const id = shared(TASK);
    const task = channels().flatMap((c) => c.tasks ?? []).find((x) => x.id === id) ?? null;
    const [label, color] = task?.dismissed ? ["Resolved", t.dim]
      : { needs: ["Needs input", t.blocked], working: ["Working", t.working], ready: ["Ready for review", t.ansi2] }[task?.standing ?? "ready"];
    const resolve = () => { resolveTask(id); showTasks(); };
    return div().size_full().bg(t.background).border_b(1).border_color(t.border)
      .child(h_flex().size_full().relative().left(this.arrived ? 0 : 14).opacity(this.arrived ? 1 : 0)
        .transition("left", 200).transition("opacity", 160).px(8).gap(8).items_center().text_color(t.foreground)
        .child(this.tool("th-back", svg(ICON("chevron-left")).size(16), () => showTasks(), t))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().id("th-name").truncate().text_size(14).font_medium().when(Boolean(task) && has("rename-task"), (el) => el.cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => renameTask(task))).child(task?.name || FRESH))
          .child(h_flex().gap(8).items_center().text_size(12.5)
            .child(div().text_color(color).child(label))
            .child(this.where(task?.machine ?? storeName(), t))))
        .when(Boolean(remoteLink(task)), (el) => el.child(this.tool("th-remote", svg(ICON("external-link")).size(15), () => { openRemote(task); }, t)))
        .when(Boolean(task) && has("rename-task"), (el) => el.child(this.tool("th-rename", svg(ICON("square-pen")).size(15), () => renameTask(task), t)))
        .when(Boolean(task) && !task.dismissed, (el) => el.child(this.tool("th-done", svg(ICON("check")).size(15), resolve, t)))
        .child(this.tool("th-close", svg(ICON("x")).size(16), () => { showTasks(); run("layout.hide", { id: TASKS_PANEL }); }, t)));
  }

  // ---------- the channel menu ----------

  render_menu() {
    const t = theme();
    const p = props();
    const item = (id, icon, label, dialog, danger) => h_flex().id(`mn-${id}`).mx(4).px(10).h(34).gap(10).items_center().rounded(6).cursor_pointer()
      .text_size(13.5).text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
      .on_click(() => { closeOverlay(p.overlay); openDialog(dialog, p.menu); })
      .child(svg(ICON(icon)).size(15)).child(label);
    return v_flex().size_full().py(4).bg(t.popover)
      .child(item("rename", "square-pen", "Rename", "rename"))
      .child(item("instructions", "file-text", "Instructions", "instructions"))
      .when(has("routines"), (el) => el.child(item("routines", "clock", "Routines", "routines")))
      .child(item("icon", "layers", "Change icon", "icon"))
      .child(div().mx(8).my(4).h(1).bg(t.border))
      .child(item("archive", "archive", "Archive", "archive"));
  }

  // ---------- a task's menu ----------

  render_taskmenu() {
    const t = theme();
    const p = props();
    const task = findTask(p.taskmenu);
    const item = (id, icon, label, action) => h_flex().id(`tm-${id}`).mx(4).px(10).h(34).gap(10).items_center().rounded(6).cursor_pointer()
      .text_size(13.5).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click(() => { closeOverlay(p.overlay); action(); })
      .child(svg(ICON(icon)).size(15)).child(label);
    return v_flex().size_full().py(4).bg(t.popover)
      .when(has("rename-task"), (el) => el.child(item("rename", "square-pen", "Rename", () => { if (task) renameTask(task); })))
      .when(isCloud(task) && !task?.dismissed, (el) => el.child(item("send", "send", "Send message…", () => sendTask(task))))
      .when(Boolean(remoteLink(task)), (el) => el.child(item("remote", "external-link", "Open on claude.ai", () => { openRemote(task); })))
      .when(Boolean(task) && !task.dismissed, (el) => el
        .when(menuTop(task) > 0, (e2) => e2.child(div().mx(8).my(4).h(1).bg(t.border)))
        .child(item("resolve", "check", "Resolve", () => { resolveTask(task.id); if (isShown(task)) showTasks(); })));
  }

  // ---------- the dialogs ----------

  initDialog(cx) {
    const p = props();
    this.kind = p.dialog;
    this.channel = channels().find((c) => c.name === p.channel) ?? null;
    this.busy = false;
    this.failed = null;
    this.icon = iconOf(this.channel);
    this.original = "";
    this.arrived = false;
    cx.timer.after(20, (cx) => { this.arrived = true; cx.notify(); });
    if (this.kind === "send-task") {
      this.task = findTask(p.task);
      this.input = InputState.new({ placeholder: "Message", value: "" });
    } else if (this.kind === "rename-task") {
      this.task = findTask(p.task);
      const name = this.task?.name ?? "";
      this.input = InputState.new({ placeholder: "Task name", value: name });
      this.input.set_selected_range({ start: 0, end: name.length });
    } else if (this.kind === "new" || this.kind === "rename") {
      this.input = InputState.new({ placeholder: "channel-name", value: this.kind === "rename" ? p.channel : "" });
      if (this.kind === "rename") this.input.set_selected_range({ start: 0, end: p.channel.length });
    } else if (this.kind === "icon") {
      this.group = 6; // Objects
      this.query = "";
      this.input = InputState.new({ placeholder: "Search emoji, or type one", value: "" });
      this.input.on("change", (_e, cx) => { this.query = `${this.input.value() ?? ""}`.trim().toLowerCase(); cx.notify(); });
    } else if (this.kind === "routines") {
      this.view = "list"; // or "edit"
      this.form = null; // the routine being edited or made
      this.entered = true; // false for a frame when the view changes, so it slides in
      this.confirm = null; // the routine whose Delete is waiting for a second click
      this.sentAt = {}; // routine id -> when Run now was pressed, for the "Sent" note
      this.leavingR = new Set(); // routines collapsing out of the list
      this.knownR = null; // routines already drawn: a new one grows in
      cx.timer.every(500, (cx) => { if (Object.values(this.sentAt).some((at) => Date.now() - at < 3500)) cx.notify(); });
      cx.timer.every(30, (cx) => { if (this.settleR) { this.settleR = false; cx.notify(); } });
      this.handle.focus();
    } else if (this.kind === "instructions") {
      this.text = TextareaState.new({ placeholder: "What this channel is for and how you want work done here.", value: "" });
      cx.spawn(async (cx) => {
        try {
          this.original = (await store('channels describe "$1"', [p.channel])).replace(/\n$/, "");
          this.text.set_value(this.original);
        } catch (err) { this.failed = String(err?.message ?? err); }
        this.text.focus();
        cx.notify();
      });
    }
    if (this.input) {
      this.input.on("submit", (_e, cx) => { if (this.kind === "icon") this.pick(this.found()[0]?.[0], cx); else this.save(cx); });
      this.input.focus();
      cx.timer.after(400, () => this.input.focus());
    } else if (this.kind === "archive") this.handle.focus();
  }

  close() { closeOverlay(props().overlay); }

  // The emoji to offer: the group's when nothing is typed, else every name that has all the
  // typed words. Text that isn't plain letters (an emoji typed or put in with the system's own
  // picker) is offered first, as itself.
  found() {
    if (!this.query) return EMOJI.filter((e) => e[2] === this.group);
    const typed = /[^\x00-\x7f]/.test(this.query) ? [[this.query, "what you typed", -1]] : [];
    const words = this.query.split(/\s+/).filter(Boolean);
    return [...typed, ...EMOJI.filter((e) => words.every((w) => e[1].includes(w)))];
  }

  // Sets the channel's icon and closes. A channel always has one, so there is no way to clear it.
  pick(icon, cx) {
    if (icon === undefined) return;
    this.icon = icon;
    this.save(cx);
  }

  // Saves and closes. The list changes at once and the store follows; a name the store would
  // refuse is caught here first, since the dialog is gone by the time the store answers.
  save(cx) {
    if (this.busy) return;
    const kind = this.kind;
    const was = props().channel;
    const typed = `${this.input?.value() ?? ""}`.trim().replace(/^#/, "").toLowerCase();
    const say = (message) => { this.failed = message; cx.notify(); };
    if (kind === "send-task") {
      const text = `${this.input.value() ?? ""}`.trim();
      if (!text) return;
      submit(() => {}, 'channels send "$1" "$2"', [props().task, text], `send to ${this.task?.name || "the task"}`);
      note(this.task?.cloud?.state === "needs" ? `Sent to ${this.task?.name || "the task"}. It waits behind its open question until that is answered on claude.ai.` : `Sent to ${this.task?.name || "the task"}.`);
      return this.close();
    }
    if (kind === "rename-task") {
      const id = props().task;
      const name = `${this.input.value() ?? ""}`.replace(/\s+/g, " ").trim();
      if (!name) return;
      if (name === this.task?.name) return this.close();
      if ([...name].length > TASK_NAME) return say(`A task name is up to ${TASK_NAME} characters.`);
      submit((all) => eachTask(all, id, (x) => { x.name = name; }), 'channels rename-task "$1" "$2"', [id, name], `rename ${this.task?.name || "the task"}`);
      return this.close();
    }
    if (kind === "new" || kind === "rename") {
      if (!typed) return;
      if (kind === "rename" && typed === was) return this.close();
      if (!NAME.test(typed)) return say("Use lowercase letters, digits, - and _, starting with a letter or digit.");
      if (channels().some((c) => c.name === typed)) return say(`There is already a channel called ${typed}.`);
    }
    if (kind === "new") {
      const last = Math.max(0, ...channels().map((c) => c.position ?? 0));
      submit((all) => all.push({ name: typed, id: null, icon: DEFAULT_ICON, position: last + 1, created_at: new Date().toISOString(), chat: null, tasks: [] }),
        'channels create "$1" --icon "$2"', [typed, DEFAULT_ICON], `create ${typed}`);
    } else if (kind === "rename") {
      submit((all) => { for (const c of all) if (c.name === was) c.name = typed; }, 'channels rename "$1" "$2"', [was, typed], `rename ${was}`);
      if (shared(CURRENT) === was) setShared(CURRENT, typed);
    } else if (kind === "icon") {
      submit((all) => { for (const c of all) if (c.name === was) c.icon = this.icon; }, 'channels icon "$1" "$2"', [was, this.icon], `change ${was}'s icon`);
    } else if (kind === "archive") {
      submit((all) => { const i = all.findIndex((c) => c.name === was); if (i !== -1) all.splice(i, 1); }, 'channels archive "$1"', [was], `archive ${was}`);
    } else if (kind === "instructions") {
      const text = `${this.text.value() ?? ""}`.replace(/\s+$/, "");
      if (text !== this.original) submit(() => {}, 'channels describe "$1" --set "$2"', [was, text], `save ${was}'s instructions`);
    }
    this.close();
  }

  render_dialog() {
    if (this.kind === "routines") return this.render_routines();
    const t = theme();
    const p = props() ?? {};
    const kind = this.kind;
    const title = { new: "New channel", rename: "Rename channel", "rename-task": "Rename task", "send-task": `Send to ${this.task?.name || "the task"}`, instructions: "Instructions", icon: "Change icon", archive: `Archive ${p.channel}?` }[kind];
    const go = { new: "Create", archive: "Archive", "send-task": "Send" }[kind] ?? "Save";
    // The button that carries the dialog's action is solid; on Archive it is the warning colour.
    const button = (id, text, primary, action) => h_flex().id(id).h(34).px(14).items_center().rounded(9)
      .bg(!primary ? t.raised : kind === "archive" ? t.blocked : t.solid)
      .text_color(!primary ? t.foreground : kind === "archive" ? "#ffffff" : t.solid_foreground)
      .text_size(13.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const field = (el) => el.px(12).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(14).text_color(t.foreground);
    const label = (text) => div().pb(8).text_size(13.5).font_medium().child(text);

    return v_flex().id("ch-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter" && kind === "archive") this.save(cx);
        else if (e.key === "enter" && kind === "instructions" && (e.modifiers?.platform || e.modifiers?.control)) this.save(cx);
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(20).bg(t.popover).text_color(t.foreground)
      .opacity(this.arrived ? 1 : 0).transition("opacity", 130)
      .child(h_flex().pb(14).items_center()
        .child(div().flex_1().text_size(16).font_semibold().child(title))
        .child(this.tool("dg-x", svg(ICON("x")).size(16), () => this.close(), t)))
      // A cloud task's question can't be answered with a message: the text waits behind it.
      .when(kind === "send-task" && this.task?.cloud?.state === "needs", (el) => el.child(div().pb(10).text_size(12.5).text_color(t.working)
        .child("It has a question open. This text waits behind it until the question is answered on claude.ai.")))
      .when(kind === "send-task", (el) => el.child(label("Message")).child(field(Input.new(this.input).h(38)))
        .child(div().pt(8).text_size(12.5).text_color(t.dim).child("Reaches the cloud session as its next message, with claude -p --cloud.")))
      .when(kind === "new" || kind === "rename" || kind === "rename-task", (el) => el.child(label("Name")).child(field(Input.new(this.input).h(38))))
      // A background session is renamed in Claude Code too; one that isn't can only be renamed from inside it.
      .when(kind === "rename-task", (el) => el.child(div().pt(8).text_size(12.5).text_color(t.dim)
        .child(isCloud(this.task) ? "Claude Code has no supported way to rename a cloud session from here: the new name shows in this panel, and claude.ai keeps its title."
          : this.task?.job ? "Renames the Claude Code session too, so claude agents shows the same name."
          : "This isn't a background session, so Claude Code can only rename it from inside, with /rename. The new name shows here; claude agents keeps the old one.")))
      .when(kind === "new", (el) => el.child(div().pt(8).text_size(12.5).text_color(t.dim)
        .child(`Lowercase letters, digits, - and _. It starts with the ${DEFAULT_ICON} icon; change that and add instructions from the channel's menu.`)))
      .when(kind === "instructions", (el) => el
        .child(h_flex().pb(10).gap(8).items_center().text_size(14).text_color(t.muted)
          .child(div().text_size(15).child(iconOf(this.channel))).child(p.channel))
        .child(field(Textarea.new(this.text).flex_1().min_h(0).py(10)))
        .child(div().pt(10).pb(14).text_size(13).text_color(t.muted).child("Claude follows these instructions in this channel's chat. Command-Return saves.")))
      .when(kind === "icon", (el) => {
        const found = this.found();
        const chip = (g, i) => div().id(`ic-g-${i}`).px(10).h(28).flex().items_center().rounded(8).text_size(12.5).cursor_pointer()
          .text_color(!this.query && this.group === i ? t.foreground : t.muted)
          .when(!this.query && this.group === i, (e2) => e2.bg(t.selected)).hover((st) => st.text_color(t.foreground))
          .on_click((_e, cx) => { this.group = i; this.query = ""; this.input.set_value(""); cx.notify(); }).child(g);
        return el
          .child(field(Input.new(this.input).h(38)))
          .child(h_flex().pt(10).pb(8).gap(2).flex_wrap().children(GROUPS.map(chip)))
          .child(div().id("ic-grid").flex_1().min_h(0).overflow_y_scrollbar()
            .child(h_flex().flex_wrap().gap(2).children(found.slice(0, SHOWN).map((e, i) => div().id(`ic-${i}`)
              .w(40).h(40).rounded(8).flex().items_center().justify_center().text_size(20).cursor_pointer()
              .when(this.icon === e[0], (e2) => e2.bg(t.selected)).hover((st) => st.bg(t.hover))
              .on_hover((hovered, cx) => { this.named = hovered ? e[1] : this.named === e[1] ? null : this.named; cx.notify(); })
              .on_click((_e, cx) => this.pick(e[0], cx)).child(e[0]))))
            .when(found.length === 0, (e2) => e2.child(div().pt(8).text_size(13).text_color(t.dim).child("No emoji with that name."))))
          .child(div().pt(8).h(26).text_size(12.5).text_color(t.muted)
            .child(this.named ?? (found.length > SHOWN ? `Showing ${SHOWN} of ${found.length}. Type to narrow.` : "Click an emoji to use it. ⌃⌘Space opens the system picker.")));
      })
      .when(kind === "archive", (el) => el.child(div().text_size(13.5).text_color(t.muted)
        .child("It leaves the sidebar. Its sessions keep running and nothing is deleted.")))
      .when(kind !== "icon" && kind !== "instructions", (el) => el.child(div().flex_1()))
      .when(Boolean(this.failed), (el) => el.child(div().pb(10).text_size(12.5).text_color(t.blocked).child(this.failed)))
      .child(h_flex().gap(8).justify_end()
        .child(button("dg-cancel", "Cancel", false, () => this.close()))
        .when(kind !== "icon", (el) => el.child(button("dg-go", go, true, (_e, cx) => this.save(cx)))));
  }

  // ---------- the Routines dialog ----------
  //
  // One overlay with two views: the channel's routines (on/off, Run now, edit, delete, next and
  // last run), and the editor for one (name, prompt, schedule preset or cron line, catch-up
  // window, on/off). Changes show at once and reach the store behind them, like every dialog here.

  channelNow() { return channels().find((c) => c.name === props().channel) ?? null; }

  slideTo(view, cx) {
    this.view = view;
    this.entered = false;
    this.confirm = null;
    cx.timer.after(20, (cx) => { this.entered = true; cx.notify(); });
    if (view === "list") this.handle.focus();
    cx.notify();
  }

  openEditor(r, cx) {
    const f = scheduleFields(r?.schedule ?? "weekdays 09:00");
    const input = (value, placeholder) => {
      const st = InputState.new({ placeholder, value });
      st.on("change", (_e, cx) => this.previewSoon(cx));
      st.on("submit", (_e, cx) => this.saveRoutine(cx));
      return st;
    };
    this.form = {
      id: r?.id ?? null, was: r?.name ?? null, preset: f.preset, day: f.day, catchup: r?.catchup_min ?? 60, enabled: r ? r.enabled : true,
      name: input(r?.name ?? "", "morning-plan"), time: input(f.time, "09:00"), minute: input(f.minute, "00"), cron: input(f.cron, "0 9 * * 1-5"),
      prompt: TextareaState.new({ placeholder: "What the chat is asked each time, e.g. Ask me for my plan for today.", value: r?.prompt ?? "" }),
      preview: null, previewFor: null, error: null,
    };
    this.slideTo("edit", cx);
    cx.timer.after(60, () => (r ? this.form?.prompt.focus() : this.form?.name.focus()));
    this.previewSoon(cx, 0);
  }

  specOf(f) {
    const v = (st) => `${st.value() ?? ""}`.trim();
    if (f.preset === "hourly") return `hourly :${v(f.minute).replace(/^:/, "") || "00"}`;
    if (f.preset === "weekly") return `weekly ${DAYS[f.day]} ${v(f.time)}`;
    if (f.preset === "cron") return `cron ${v(f.cron)}`;
    return `${f.preset} ${v(f.time)}`;
  }

  // The schedule in words and its next runs, from `channels routine preview`, a moment after the
  // last change: the command is the one judge of what a schedule means.
  previewSoon(cx, ms = 220) {
    const f = this.form;
    if (!f) return;
    const spec = this.specOf(f);
    f.want = spec;
    cx.timer.after(ms, (cx) => {
      if (this.form !== f || f.want !== spec || f.previewFor === spec) return;
      store('channels routine preview "$1" --json', [spec]).then((out) => {
        if (this.form !== f || f.want !== spec) return;
        f.preview = JSON.parse(out);
        f.previewFor = spec;
        cx.notify();
      }).catch((err) => { f.preview = { error: String(err?.message ?? err) }; cx.notify(); });
    });
    cx.notify();
  }

  saveRoutine(cx) {
    const f = this.form;
    const c = this.channelNow();
    if (!f || !c) return;
    const name = `${f.name.value() ?? ""}`.trim().toLowerCase();
    const prompt = `${f.prompt.value() ?? ""}`.trim();
    const spec = this.specOf(f);
    const say = (error) => { f.error = error; cx.notify(); };
    if (!NAME.test(name)) return say("Name it with lowercase letters, digits, - and _, like morning-plan.");
    if ((c.routines ?? []).some((r) => r.name === name && r.id !== f.id)) return say(`#${c.name} already has a routine called ${name}.`);
    if (!prompt) return say("Write the prompt: what the chat is asked each time.");
    if (f.previewFor === spec && f.preview?.error) return say(f.preview.error);
    const shown = { name, prompt, schedule: f.preview?.spec ?? spec, label: f.previewFor === spec ? f.preview?.label ?? spec : spec, catchup_min: f.catchup, enabled: f.enabled, next_at: f.enabled ? f.preview?.next?.[0] ?? null : null };
    const args = [c.name, f.was ?? name, spec, String(f.catchup), prompt, name];
    if (f.id) {
      submit((all) => { for (const ch of all) if (ch.name === c.name) for (const r of ch.routines ?? []) if (r.id === f.id) Object.assign(r, shown); },
        `channels routine edit "$1" "$2" --schedule "$3" --catchup "$4" --prompt "$5" --rename "$6" && channels routine ${f.enabled ? "on" : "off"} "$1" "$6"`, args, `save the routine ${name}`);
    } else {
      submit((all) => { for (const ch of all) if (ch.name === c.name) (ch.routines ??= []).push({ id: `new-${name}`, last: null, ...shown }); },
        `channels routine add "$1" "$6" --schedule "$3" --catchup "$4" --prompt "$5"${f.enabled ? "" : " --off"}`, args, `add the routine ${name}`);
    }
    this.form = null;
    this.slideTo("list", cx);
  }

  setRoutine(r, change, script, what) {
    const c = this.channelNow();
    submit((all) => { for (const ch of all) if (ch.name === c.name) for (const x of ch.routines ?? []) if (x.id === r.id) Object.assign(x, change); }, script, [c.name, r.name], what);
  }

  toggleRoutine(r, on) {
    this.setRoutine(r, { enabled: on, next_at: on ? r.next_at : null }, `channels routine ${on ? "on" : "off"} "$1" "$2"`, `switch ${r.name} ${on ? "on" : "off"}`);
  }

  runNow(r, cx) {
    this.sentAt[r.id] = Date.now();
    this.setRoutine(r, { last: { kind: "manual", status: "queued", at: new Date().toISOString(), late_min: 0 } }, 'channels routine run "$1" "$2"', `run ${r.name}`);
    cx.notify();
  }

  removeRoutine(r, cx) {
    if (this.confirm !== r.id) { this.confirm = r.id; return cx.notify(); }
    this.confirm = null;
    this.leavingR.add(r.id);
    cx.notify();
    cx.timer.after(190, (cx) => {
      const c = this.channelNow();
      submit((all) => { for (const ch of all) if (ch.name === c.name) ch.routines = (ch.routines ?? []).filter((x) => x.id !== r.id); },
        'channels routine rm "$1" "$2"', [c.name, r.name], `delete ${r.name}`);
      this.leavingR.delete(r.id);
      if (this.form?.id === r.id) { this.form = null; this.slideTo("list", cx); }
      cx.notify();
    });
  }

  // A switch drawn the macOS way: the track fills with the accent colour and the knob springs across.
  switchFor(id, on, change, t) {
    return Switch.new(id).checked(on).on_change((v, cx) => { change(v, cx); cx.notify(); }).accessibility_label(on ? "On" : "Off")
      .relative().flex_none().w(34).h(20).rounded(10).bg(t.raised).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().absolute().top(0).left(0).w(34).h(20).rounded(10).bg(t.accent).opacity(on ? 1 : 0).transition("opacity", 160))
      .child(div().absolute().top(2).left(on ? 16 : 2).w(16).h(16).rounded(8).bg("#ffffff").shadow_sm().spring("left", { response: 220, damping: 0.78 }));
  }

  // A row of choices with one picked: a highlight that glides to the picked one.
  segmented(id, options, value, pick, t) {
    const at = Math.max(0, options.findIndex((o) => o[0] === value));
    const left = options.slice(0, at).reduce((sum, o) => sum + o[2] + 2, 0);
    return RadioGroup.new(id).relative().flex().flex_row().flex_none().self_start().gap(2).p(3).rounded(10).bg(t.background)
      .child(div().absolute().top(3).h(28).left(3 + left).w(options[at]?.[2] ?? 0).rounded(7).bg(t.raised).shadow_sm()
        .spring("left", { response: 240, damping: 0.86 }).transition("width", 180))
      .children(options.map(([v, label, w]) => Radio.new(`${id}-${v}`).checked(v === value).on_change((_on, cx) => { pick(v, cx); cx.notify(); })
        .relative().w(w).h(28).flex().items_center().justify_center().rounded(7).text_size(13).cursor_pointer()
        .text_color(v === value ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground)).child(label)));
  }

  routineRow(r, t, fresh) {
    const key = `rt:${r.id}`;
    const hover = this.hover === key;
    const confirming = this.confirm === r.id;
    const closed = this.leavingR.has(r.id) || fresh;
    const sent = Date.now() - (this.sentAt[r.id] ?? 0) < 3000;
    const [last, lastColor] = lastRun(r, t);
    const meta = h_flex().gap(14).text_size(12).text_color(t.dim)
      .child(h_flex().gap(4).child("Next").child(div().text_color(r.enabled && r.next_at ? t.muted : t.dim).child(r.enabled ? (r.next_at ? whenText(r.next_at) : "-") : "Off")))
      .child(h_flex().gap(4).min_w(0).child("Last").child(div().truncate().text_color(lastColor).child(sent ? "sent to the chat just now" : last)));
    return h_flex().id(`rt-${r.id}`).flex_none().overflow_hidden().h(closed ? 0 : 78).opacity(closed ? 0 : 1).transition("height", 180).transition("opacity", 150)
      .child(h_flex().id(`rt-in-${r.id}`).flex_1().min_w(0).h(74).px(12).gap(12).items_center().rounded(10)
        .when(hover || confirming, (el) => el.bg(t.raised))
        .on_hover(this.hovering(key))
        .child(div().w(30).h(30).flex_none().rounded(8).bg(hover || confirming ? t.background : t.raised).flex().items_center().justify_center()
          .child(svg(ICON("clock")).size(15).text_color(r.enabled ? t.accent : t.dim)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(8).items_baseline().min_w(0)
            .child(div().flex_none().text_size(14).font_medium().text_color(r.enabled ? t.foreground : t.muted).child(r.name))
            .child(div().truncate().text_size(12.5).text_color(r.error ? t.blocked : t.muted).child(r.error ?? r.label ?? r.schedule)))
          .child(div().truncate().text_size(12.5).text_color(t.dim).child(r.prompt))
          .child(meta))
        .when(confirming, (el) => el
          .child(div().text_size(12.5).text_color(t.muted).child("Delete it?"))
          .child(this.smallButton(`rt-no-${r.id}`, "Cancel", false, (_e, cx) => { this.confirm = null; cx.notify(); }, t))
          .child(this.smallButton(`rt-yes-${r.id}`, "Delete", "danger", (_e, cx) => this.removeRoutine(r, cx), t)))
        .when(!confirming, (el) => el
          // The row's actions show on hover, and keep their place either way so nothing moves.
          .child(h_flex().gap(2).items_center().opacity(hover ? 1 : 0).transition("opacity", 120)
            .child(this.smallButton(`rt-run-${r.id}`, h_flex().gap(5).items_center().child(svg(ICON("play")).size(11)).child("Run now"), false, (_e, cx) => this.runNow(r, cx), t))
            .child(this.tool(`rt-edit-${r.id}`, svg(ICON("square-pen")).size(14), (_e, cx) => this.openEditor(r, cx), t))
            .child(this.tool(`rt-del-${r.id}`, svg(ICON("trash-2")).size(14), (_e, cx) => this.removeRoutine(r, cx), t)))
          .child(this.switchFor(`rt-on-${r.id}`, r.enabled, (on) => this.toggleRoutine(r, on), t))));
  }

  smallButton(id, label, kind, action, t) {
    return h_flex().id(id).h(26).px(9).items_center().rounded(6).text_size(12.5).font_medium().cursor_pointer()
      .bg(kind === "danger" ? t.blocked : t.selected).text_color(kind === "danger" ? "#ffffff" : t.foreground)
      .hover((st) => st.opacity(0.88)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  render_routines() {
    const t = theme();
    const c = this.channelNow();
    const p = props() ?? {};
    const failed = shared(FAIL);
    const button = (id, text, primary, action) => h_flex().id(id).h(34).px(14).gap(6).items_center().rounded(9)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(13.5).font_medium().cursor_pointer().hover((st) => st.opacity(0.88)).on_click(action).child(text);
    const head = (title, back) => h_flex().pb(back ? 16 : 6).gap(6).items_center()
      .when(Boolean(back), (el) => el.child(this.tool("rt-back", svg(ICON("chevron-left")).size(16), back, t)))
      .child(div().flex_1().text_size(16).font_semibold().child(title));

    let body;
    if (this.view === "edit" && this.form) {
      const f = this.form;
      const label = (text) => div().pt(16).pb(8).text_size(13.5).font_medium().child(text);
      const field = (el, w) => el.px(12).rounded(9).border_1().border_color(t.border).bg(t.background).text_size(14).text_color(t.foreground).when(Boolean(w), (e) => e.w(w));
      const spec = this.specOf(f);
      const pv = f.previewFor === spec ? f.preview : null;
      const scheduleLine = {
        weekdays: () => h_flex().gap(10).items_center().child(div().text_size(13).text_color(t.muted).child("Monday to Friday at")).child(field(Input.new(f.time).h(30), 84)),
        daily: () => h_flex().gap(10).items_center().child(div().text_size(13).text_color(t.muted).child("Every day at")).child(field(Input.new(f.time).h(30), 84)),
        hourly: () => h_flex().gap(10).items_center().child(div().text_size(13).text_color(t.muted).child("Every hour at minute")).child(field(Input.new(f.minute).h(30), 64)),
        weekly: () => h_flex().gap(10).items_center()
          .child(RadioGroup.new("rt-days").flex().flex_row().gap(4).children(WEEK.map((d) => Radio.new(`rt-day-${d}`).checked(f.day === d)
            .on_change((_on, cx) => { f.day = d; this.previewSoon(cx); }).w(40).h(30).flex().items_center().justify_center().rounded(8).text_size(12.5).cursor_pointer()
            .bg(f.day === d ? t.accent : t.raised).text_color(f.day === d ? t.accent_foreground : t.muted).when(f.day !== d, (el) => el.hover((st) => st.text_color(t.foreground)))
            .child(DAY_LABELS[d]))))
          .child(div().text_size(13).text_color(t.muted).child("at")).child(field(Input.new(f.time).h(30), 84)),
        cron: () => v_flex().gap(6).flex_1()
          .child(field(Input.new(f.cron).h(34)).border_color(pv?.error ? t.blocked : t.border))
          .child(h_flex().gap(18).pl(12).text_size(11.5).text_color(t.dim).children(["minute", "hour", "day", "month", "weekday"].map((x) => div().child(x)))),
      }[f.preset]();
      const catchups = CATCHUP.some((o) => o[0] === f.catchup) ? CATCHUP : [...CATCHUP, [f.catchup, f.catchup % 60 ? `${f.catchup} min` : `${f.catchup / 60} h`, 64]];
      const next = pv?.error ? null : pv?.next ?? null;
      body = v_flex().flex_1().min_h(0)
        .child(head(f.id ? "Edit routine" : "New routine", (_e, cx) => { this.form = null; this.slideTo("list", cx); })
          .child(div().text_size(13).text_color(t.muted).child(f.enabled ? "On" : "Off"))
          .child(this.switchFor("rt-enabled", f.enabled, (on) => { f.enabled = on; }, t)))
        .child(div().pb(8).text_size(13.5).font_medium().child("Name"))
        .child(field(Input.new(f.name).h(38)))
        .child(label("Prompt"))
        .child(field(Textarea.new(f.prompt).h(92).py(10)))
        .child(label("Schedule"))
        .child(this.segmented("rt-preset", PRESETS, f.preset, (v, cx) => { f.preset = v; this.previewSoon(cx, 0); }, t))
        .child(h_flex().pt(10).min_h(40).child(scheduleLine))
        .when(f.preset === "cron" && Boolean(pv?.error), (el) => el.child(div().pt(6).text_size(12.5).text_color(t.blocked).child(pv.error)))
        .when(f.preset !== "cron" && Boolean(pv?.error), (el) => el.child(div().pt(6).text_size(12.5).text_color(t.blocked).child(pv.error)))
        .child(label(B.routineClock(ON).missed))
        .child(this.segmented("rt-catchup", catchups, f.catchup, (v) => { f.catchup = v; }, t))
        .child(div().flex_1())
        .child(h_flex().pb(12).gap(8).items_center().text_size(12.5).text_color(f.error ? t.blocked : t.dim)
          .child(svg(ICON("clock")).size(13).text_color(t.dim))
          .child(div().truncate().child(f.error ?? (pv?.error ? "Fix the schedule to see when it runs next."
            : !next ? "Working out when it runs…"
            : `${pv.label}. ${f.enabled ? `Next ${whenText(next[0])}${next[1] ? `, then ${whenText(next[1])}` : ""}.` : "Off: it won't run until you switch it on."} ${B.routineClock(ON).short}`))))
        .child(h_flex().gap(8).items_center()
          .when(Boolean(f.id), (el) => el.child(h_flex().id("rt-delete").h(34).px(12).items_center().rounded(9).text_size(13.5).font_medium().cursor_pointer()
            .text_color(t.blocked).hover((st) => st.bg(t.raised))
            .on_click((_e, cx) => { const r = (c?.routines ?? []).find((x) => x.id === f.id); if (r) { this.confirm = r.id; this.removeRoutine(r, cx); } })
            .child("Delete")))
          .child(div().flex_1())
          .child(button("rt-cancel", "Cancel", false, (_e, cx) => { this.form = null; this.slideTo("list", cx); }))
          .child(button("rt-save", f.id ? "Save" : "Create", true, (_e, cx) => this.saveRoutine(cx))));
    } else {
      const list = c?.routines ?? [];
      const fresh = new Set(this.knownR ? list.filter((r) => !this.knownR.has(r.id)).map((r) => r.id) : []);
      this.knownR = new Set(list.map((r) => r.id));
      if (fresh.size) cx_settle(this);
      body = v_flex().flex_1().min_h(0)
        .child(head("Routines", null).child(this.tool("dg-x", svg(ICON("x")).size(16), () => this.close(), t)))
        .child(h_flex().pb(14).gap(8).items_center().text_size(14).text_color(t.muted).child(div().text_size(15).child(iconOf(c))).child(p.channel))
        .child(v_flex().id("rt-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
          .children(list.map((r) => this.routineRow(r, t, fresh.has(r.id))))
          .when(list.length === 0, (el) => el.child(v_flex().pt(48).gap(6).items_center()
            .child(svg(ICON("clock")).size(22).text_color(t.dim))
            .child(div().pt(6).text_size(14).text_color(t.muted).child("No routines yet"))
            .child(div().text_size(12.5).text_color(t.dim).child("A routine types a prompt into this channel's chat on a schedule.")))))
        .child(div().pt(10).pb(14).text_size(12.5).text_color(t.dim)
          .child(`Each routine types its prompt into this channel's chat on schedule, starting the chat if it isn't open. ${B.routineClock(ON).times}`))
        .child(h_flex().gap(8).items_center()
          .child(button("rt-new", h_flex().gap(6).items_center().child(svg(ICON("plus")).size(14)).child("New routine"), false, (_e, cx) => this.openEditor(null, cx)))
          .child(div().flex_1())
          .child(button("rt-done", "Done", true, () => this.close())));
    }
    return v_flex().id("ch-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (this.view === "edit") { this.form = null; this.slideTo("list", cx); } else this.close(); }
        else if (e.key === "enter" && this.view === "edit" && (e.modifiers?.platform || e.modifiers?.control)) this.saveRoutine(cx);
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(20).bg(t.popover).text_color(t.foreground)
      .opacity(this.arrived ? 1 : 0).transition("opacity", 130)
      .child(v_flex().size_full().min_h(0).relative().left(this.entered ? 0 : (this.view === "edit" ? 14 : -14)).opacity(this.entered ? 1 : 0)
        .transition("left", 200).transition("opacity", 160)
        .child(body)
        .when(Boolean(failed) && Date.now() - failed.at < 12000, (el) => el.child(div().pt(8).text_size(12.5).text_color(t.blocked).child(failed?.message ?? ""))));
  }
}
