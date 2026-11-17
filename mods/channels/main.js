// channels: a channels front end for herdr, laid out like Claude Duet. One mod in several roles,
// placed by layouts/channels.json and by its own overlays:
//
// - the sidebar (no props): the channels, each with an icon and an L-shaped connector, a "…"
//   menu on hover and "New channel" at the bottom. It also reads the `channels` store on this
//   machine on a timer and shares the result, so the other copies never poll.
// - the bar ({ bar: true }): what the main area is showing, and the button for the tasks panel.
// - the panel ({ panel: true }): "Tasks in #channel". A task is one Claude Code session; clicking
//   one shows it live in the panel. + starts a fresh session in the projects folder.
// - the menu ({ menu: channel }) and the dialogs ({ dialog: "new" | "rename" | "instructions" |
//   "icon" | "archive", channel }), opened as overlays.
//
// The main area is herdr's shown tab. A channel's chat gets one tab, in a herdr space called
// "channels", made on first use and reused after. Everything runs on this machine: the
// `channels` command (bin/channels.mjs in the herdr-channels repo) holds the store, and
// config.js beside this file says where it is.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { EMOJI, GROUPS } from "./emoji.js";
import CONFIG from "./config.js";
import { exec, hc, readTextFile, appHome, spaces, panes, terminals, layout, theme, run, nextCommand, home, props, shared, setShared, openOverlay, closeOverlay, window } from "herdr";

// The settings, from config.js (install.mjs writes it). MOD and LAYOUT are this mod's folder and
// its layout's name, which the install changes when "channels" is already taken.
const MOD = CONFIG.mod || "channels";
const LAYOUT = CONFIG.layout || "channels";
const COMMAND = CONFIG.command || "channels"; // the channels command: a path, or a name on PATH
// Where it, node, claude, hc and python3 are: a program started from the app gets a short PATH.
const PATHS = [CONFIG.path, "$HOME/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
const PROJECTS = CONFIG.projects || `${home()}/projects`; // where a fresh session and a channel chat start
const BY = CONFIG.by || "user"; // who a task resolved here is recorded as resolved by
const HOLD = "channels"; // the herdr space that holds the chats' tabs
const DATA = "channels.data"; // what the sidebar last read: { channels, error, at }
const TICK = "channels.tick"; // bumped after a change so the sidebar reads the store again
const CURRENT = "channels.current"; // the selected channel's name
const ORDER = "channels.order"; // this computer's channel order (ids), until the store keeps one
const TASK = "channels.task"; // the id of the task open in the tasks panel, if any
const TASK_TERM = "channels.taskterm"; // and the address of the terminal showing it
const LIST_FOCUS = "channels.listfocus"; // when the panel went back to the task list, so the list takes the keyboard
const LAST_TASK = "channels.lasttask"; // the task that was open, so the list's cursor starts on it
const OPENED = "channels.opened"; // when a task was last opened in the panel, so its prompt takes the keyboard
const DEFAULT_ICON = "💬"; // every channel has an icon; this is the one a new channel starts with
const iconOf = (channel) => channel?.icon || DEFAULT_ICON;
const FRESH = "New session";
// Every task is a background session shown through the viewer, viewer.py beside this file: `claude
// attach` behind a pass-through terminal that notices the moment you leave the session (left
// arrow on an empty prompt, /exit, ctrl+z), marks its terminal with the "herdr.back" label, which
// the panel watches to return to the task list, and attaches again for the next visit. The file
// says why it exists. It is sent as the program text, so only python3 is needed.
const NO_AGENTS = ["--settings", '{"disableAgentView":true}'];
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
// says, from CHANNELS_MACHINE or the host name.
const localName = () => shared(DATA)?.machine ?? null;

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

// Runs a shell line on this machine. The folders for PATH arrive as $0 and the channels command as
// $1, so no quoting can go wrong; `channels` in the line runs that command, and the line's own
// args arrive as "$1", "$2", ...
const sh = (script, args = [], { timeout = 30000 } = {}) =>
  exec("sh", ["-c", `PATH="$0:$PATH"; CHANNELS_CMD="$1"; shift; channels() { "$CHANNELS_CMD" "$@"; }; ${script}`, PATHS, COMMAND, ...args], { timeout });

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
const OPS = "channels.ops"; // queued commands: { script, args, what, at }
const BUSY = "channels.busy"; // the sidebar is carrying the queue out
const OP_AT = "channels.opAt"; // when something last changed here
const FAIL = "channels.fail"; // the last command that failed: { message, at }
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
  const channels = JSON.parse(list).channels ?? [];
  const index = (text) => {
    const by = new Map();
    try { for (const a of JSON.parse(text)) { if (a.sessionId) by.set(a.sessionId, a); if (a.id) by.set(a.id, a); } } catch { /* none */ }
    return by;
  };
  const agents = index(there);
  for (const c of channels) {
    for (const t of c.tasks ?? []) {
      const a = agents.get(t.session_id) ?? agents.get(t.job);
      if (a?.name) t.name = a.name;
      t.standing = standing(a);
    }
  }
  return { machine: JSON.parse(list).machine ?? null, channels };
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
const liveTasks = (channel) => (channel?.tasks ?? []).filter((t) => !t.dismissed).sort((a, b) => `${b.added_at}`.localeCompare(`${a.added_at}`));
const doneTasks = (channel) => (channel?.tasks ?? []).filter((t) => t.dismissed).sort((a, b) => `${b.dismissed_at}`.localeCompare(`${a.dismissed_at}`));

// The herdr machine a task runs on: null is this computer, undefined is one we can't reach (a
// task filed under another name: the store is this computer's only).
function herdrMachine(task) {
  return task.machine === localName() ? null : undefined;
}

const shortId = (task) => task.job ?? task.session_id.split("-")[0];
const holdSpace = (machine) => spaces().find((p) => (p.machine ?? null) === machine && p.name === HOLD) ?? null;
const tabOf = (space, task) => space?.tabs.find((t) => t.name === shortId(task) || t.name.startsWith(`${shortId(task)} `)) ?? null;

// Shows `argv` as the tab for `task` in its machine's holding space, making the space if needed.
// A tab whose program has exited (only its shell is left) is replaced, so the command runs again.
function showTab(machine, task, argv, folder) {
  const name = `${shortId(task)} ${task.name ?? ""}`.trim();
  const space = holdSpace(machine);
  if (!space) return run("space.new", { name: HOLD, machine: machine ?? "", folder, tab: name, argv });
  run("space.select", { id: space.id });
  const tab = tabOf(space, task);
  const dead = tab && panes().some((p) => p.tab === tab.id && p.program?.shell);
  if (tab && !dead) return run("tab.select", { id: tab.id });
  run("tab.new", { space: space.id, name, folder, argv });
  if (dead) run("tab.close", { id: tab.id, confirmed: true });
}

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
// "taskview" child holding the task's header and its live terminal.
function showInPanel(task, address) {
  const tree = JSON.parse(JSON.stringify(layout()));
  const panel = find(tree, "panel");
  if (!panel) return;
  panel.children = [panel.children.find((n) => n.id === "tasks"), {
    id: "taskview", type: "column", resizable: false,
    children: [
      { id: "taskhead", type: "block", size: { px: HEAD }, content: { mod: MOD, props: { taskhead: true } } },
      { id: "taskterm", type: "block", content: { terminal: address } },
    ],
  }];
  panel.active = "taskview";
  panel.hidden = false;
  setShared(TASK, task.id);
  setShared(TASK_TERM, address);
  setShared(OPENED, Date.now());
  run("layout.set", { layout: tree });
  run("pane.focus", { terminal: address });
}
const showTasks = () => {
  if (shared(TASK)) setShared(LAST_TASK, shared(TASK));
  setShared(TASK, null);
  setShared(LIST_FOCUS, Date.now());
  run("layout.select", { stack: "panel", child: "tasks" });
};

// Opens a task in the panel: a background session is attached to; one from before tasks were all
// background sessions (a plain `claude`, no job) is resumed.
async function openTask(task) {
  const machine = herdrMachine(task);
  if (machine === undefined) throw new Error(`${task.machine} can't be reached from this computer.`);
  let address = findTerm(task, machine);
  if (!address) {
    const there = (a) => (machine ? `${a}`.startsWith(`${machine}/`) : !`${a}`.includes("/"));
    const old = OLD_VIEWERS.map((prefix) => viewerName(prefix, task));
    for (const x of terminals()) if (old.includes(x.name) && there(x.address)) run("terminal.kill", { terminal: x.address });
    const cmd = task.job || !UUID.test(task.session_id) ? await attachTo(shortId(task)) : ["claude", "--resume", task.session_id, ...NO_AGENTS];
    const folder = task.folder ?? PROJECTS;
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", termName(task), "--cwd", folder,
      "--", "sh", "-c", 'PATH="$0:$PATH" exec "$@"', PATHS, ...cmd]);
    if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim() || `hc exited ${r.code}`).split("\n").pop());
    address = JSON.parse(r.stdout).address;
  }
  showInPanel(task, address);
}

// A channel's chat: one long-lived session on this machine. `channels chat <name>` starts it the
// first time and resumes it after, and listens for its tasks beside it, so its tab only ever runs
// that one command. The tab is keyed by the channel's id (its name until the store gives it one),
// so a rename keeps the running chat.
const chatOf = (c) => ({ machine: localName(), session_id: `#${c.id ?? c.name}`, job: `#${c.id ?? c.name}`, name: "", folder: PROJECTS });
function openChannel(c) {
  // The panel follows the channel: a task left open from another channel goes back to the list.
  const leaving = current()?.name !== c.name;
  setShared(CURRENT, c.name);
  if (leaving && shared(TASK)) showTasks();
  showTab(null, chatOf(c), ["sh", "-c", 'PATH="$0:$PATH" exec "$@"', PATHS, COMMAND, "chat", c.name], PROJECTS);
}

const isShown = (task) => shared(TASK) === task.id;

// Whether the main area is showing this channel's chat. The main area is herdr's shown tab, which
// every layout shares: another layout, or a key, can leave something else there.
function chatShown(c) {
  const space = spaces().find((p) => p.active);
  if (!space || space.name !== HOLD || (space.machine ?? null) !== null) return false;
  const tab = tabOf(space, chatOf(c));
  return Boolean(tab && tab.active);
}

// The selected channel: the one clicked last, else the one whose task is on screen, else the first.
function current() {
  const all = channels();
  return all.find((c) => c.name === shared(CURRENT)) ?? all.find((c) => liveTasks(c).some(isShown)) ?? all[0] ?? null;
}

const ask = (dialog, channel, width, height) => openOverlay({ mod: MOD, kind: "dialog", width, height, props: { dialog, channel } });
const DIALOGS = { new: [520, 250], rename: [460, 220], instructions: [620, 470], icon: [560, 560], archive: [440, 190] };
const openDialog = (dialog, channel) => ask(dialog, channel, ...DIALOGS[dialog]);

export default class Channels extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.dialog ? "dialog" : p.menu ? "menu" : p.head ? "head" : p.taskhead ? "taskhead" : p.panel ? "panel" : p.bar ? "bar" : "sidebar";
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
    setShared(BUSY, false);
    cx.timer.every(40, (cx) => {
      if (this.settle) { this.settle = false; cx.notify(); }
      this.drain(cx);
    });
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.restoredAt = 0;
    cx.timer.every(1000, (cx) => {
      const now = shared(TICK) ?? 0;
      if (now !== this.tick) { this.tick = now; this.refresh(cx); }
      // Put the selected channel's chat back if the main area is showing anything else, as it
      // does after a visit to another layout. Not more than once every few seconds: a chat's tab
      // takes a moment to appear the first time.
      const here = current();
      if (here && shared("layout") === LAYOUT && !chatShown(here) && Date.now() - this.restoredAt > 4000) {
        this.restoredAt = Date.now();
        openChannel(here);
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
          const list = liveTasks(current()).filter((x) => herdrMachine(x) !== undefined);
          const at = list.findIndex(isShown);
          if (list.length) openTask(list[(at + (c === "task-next" ? 1 : -1) + list.length) % list.length]).catch(() => {});
        } else if (c === "tasks") showTasks();
        // channels.rename / .instructions / .icon / .archive: that dialog for the selected channel.
        else if (DIALOGS[c] && c !== "new" && current()) openDialog(c, current().name);
        cx.notify();
      }
    });
  }

  refresh(cx) {
    cx.spawn(async () => {
      const started = Date.now();
      let next;
      try { next = { ...(await readStore()), error: null, at: Date.now() }; }
      catch (err) { next = { machine: shared(DATA)?.machine ?? null, channels: shared(DATA)?.channels ?? [], error: String(err?.message ?? err), at: Date.now() }; }
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
      .child(svg(ICON(machine === localName() ? "monitor" : "server")).size(12)).child(machine ?? "");
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
    const menu = (c) => openOverlay({ mod: MOD, kind: "popup", width: 200, height: 156, props: { menu: c.name } });
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
      const selected = here?.name === c.name;
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
      .child(this.footer(t, data));
  }

  // The foot of the sidebar: this machine, which holds the channels, and whether the store answers.
  footer(t, data) {
    const [color, text] = data?.error ? [t.blocked, "store unreadable"] : data ? [t.ansi2, "on this Mac"] : [t.dim, "reading…"];
    return h_flex().h(44).flex_none().px(18).gap(10).items_center().border_t(1).border_color(t.border)
      .child(div().w(8).h(8).rounded(4).bg(color))
      .child(svg(ICON("monitor")).size(13).text_color(t.muted))
      .child(div().text_size(13).text_color(t.muted).child(data?.machine ?? "this Mac"))
      .child(div().flex_1().text_size(12.5).text_color(t.dim).child(text));
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
      .when(Boolean(here) && Boolean(localName()), (el) => el.child(this.where(localName(), t)))
      .child(this.tool("bar-tasks", svg(ICON("panel-right")).size(16), () => run("layout.toggle", { id: "panel" }), t)
        .when(!find(layout(), "panel")?.hidden, (el) => el.bg(t.selected).text_color(t.foreground)));
  }

  // ---------- the tasks panel ----------

  // A fresh Claude Code session in the projects folder: a background session with no prompt yet.
  // Its row appears at once and the session opens as soon as Claude Code has made it. `claude
  // --bg` picks the session's id itself, so it is filed by its job.
  startFresh(channel, cx) {
    const id = uuid();
    const task = { id: `pending/${id}`, machine: localName(), session_id: id, job: null, name: FRESH, folder: PROJECTS, standing: "needs", added_at: new Date().toISOString() };
    this.pending.push({ channel, task });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // `claude --bg` prints the commands for the new session; the id they name is its job.
        const out = await store('cd "$1" && claude --bg 2>&1', [PROJECTS], 60000);
        task.job = out.match(/claude attach (\S+)/)?.[1] ?? null;
        if (!task.job) throw new Error(out.trim().split("\n").pop() || "claude --bg gave no session");
        await openTask(task);
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
    if (task.unread) submit((all) => eachTask(all, task.id, (x) => { x.unread = null; }), 'channels seen "$1"', [task.id], `mark ${task.name || "the task"} seen`);
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
      return h_flex().id(`tk-${task.id}`).mx(8).px(8).gap(12).items_center().rounded(8).overflow_hidden().flex_none()
        .h(closed ? 0 : TASK_H).opacity(closed ? 0 : 1).transition("height", 180).transition("opacity", 150)
        .when(reachable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(task, cx)))
        .on_hover(this.hovering(key))
        .child(div().w(28).h(28).flex_none().rounded(8).bg(t.raised).flex().items_center().justify_center().child(mark[kind]()))
        .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(reachable ? t.foreground : t.dim).when(unread, (el) => el.font_medium()).child(task.name || shortId(task)))
        // A task with an event not seen yet (it finished, or asked something, since it was last opened) has a dot.
        .when(unread, (el) => el.child(div().id(`tk-new-${task.id}`).w(8).h(8).flex_none().rounded(4).bg(t.accent)))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(ago(kind === "resolved" ? task.dismissed_at : task.added_at)))
        // The resolve button keeps its place whether or not it shows, so hovering moves nothing.
        .child(div().w(24).flex_none().opacity(canResolve && this.hover === key ? 1 : 0).transition("opacity", 120)
          .when(canResolve, (el) => el.child(this.tool(`tk-done-${task.id}`, svg(ICON("check")).size(14), (_e, cx) => this.resolve(task, cx), t))));
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
          .child(this.tool("tp-close", svg(ICON("x")).size(16), () => run("layout.hide", { id: "panel" }), t)))
        .child(h_flex().px(8).pt(10).pb(4).flex_none().gap(2).child(pill("active", "Active")).child(pill("resolved", "Resolved")))
        .when(Boolean(this.failed), (el) => el.child(div().px(16).py(4).text_size(12).text_color(t.blocked).child(this.failed)))
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
    const resolve = () => {
      submit((all) => eachTask(all, id, (x) => { x.dismissed = true; x.dismissed_at = new Date().toISOString(); x.dismissed_by = BY; }),
        'channels dismiss "$1" --by "$2"', [id, BY], `resolve ${task?.name || "the task"}`);
      showTasks();
    };
    return div().size_full().bg(t.background).border_b(1).border_color(t.border)
      .child(h_flex().size_full().relative().left(this.arrived ? 0 : 14).opacity(this.arrived ? 1 : 0)
        .transition("left", 200).transition("opacity", 160).px(8).gap(8).items_center().text_color(t.foreground)
        .child(this.tool("th-back", svg(ICON("chevron-left")).size(16), () => showTasks(), t))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(14).font_medium().child(task?.name || FRESH))
          .child(h_flex().gap(8).items_center().text_size(12.5)
            .child(div().text_color(color).child(label))
            .child(this.where(task?.machine ?? localName(), t))))
        .when(Boolean(task) && !task.dismissed, (el) => el.child(this.tool("th-done", svg(ICON("check")).size(15), resolve, t)))
        .child(this.tool("th-close", svg(ICON("x")).size(16), () => { showTasks(); run("layout.hide", { id: "panel" }); }, t)));
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
      .child(item("icon", "layers", "Change icon", "icon"))
      .child(div().mx(8).my(4).h(1).bg(t.border))
      .child(item("archive", "archive", "Archive", "archive"));
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
    if (this.kind === "new" || this.kind === "rename") {
      this.input = InputState.new({ placeholder: "channel-name", value: this.kind === "rename" ? p.channel : "" });
      if (this.kind === "rename") this.input.set_selected_range({ start: 0, end: p.channel.length });
    } else if (this.kind === "icon") {
      this.group = 6; // Objects
      this.query = "";
      this.input = InputState.new({ placeholder: "Search emoji, or type one", value: "" });
      this.input.on("change", (_e, cx) => { this.query = `${this.input.value() ?? ""}`.trim().toLowerCase(); cx.notify(); });
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
    const t = theme();
    const p = props() ?? {};
    const kind = this.kind;
    const title = { new: "New channel", rename: "Rename channel", instructions: "Instructions", icon: "Change icon", archive: `Archive ${p.channel}?` }[kind];
    const go = { new: "Create", archive: "Archive" }[kind] ?? "Save";
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
      .when(kind === "new" || kind === "rename", (el) => el.child(label("Name")).child(field(Input.new(this.input).h(38))))
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
}
