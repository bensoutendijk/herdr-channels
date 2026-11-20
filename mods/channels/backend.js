// Where the channels store lives and what its command can do. Plain functions, so the tests can run them without
// herdr (main.js does the herdr side).
//
// The store is this repo's `channels` on this computer by default. config.js can point the mod at another command on
// another machine instead: `hub channels` on a home server, say, which keeps the store there and runs tasks on
// several machines. Then:
// - `on` is the Herdr machine the command runs on ("" is this computer),
// - `local` is what that store calls this computer (its tasks are filed as `<local>/<session>`). It has to be set
//   for a store on another machine: the `machine` that store's `list --json` gives is its own name, not this one's.
// - `projects` is where a fresh session and a chat start on the store's machine.

// The settings config.js gives, filled in. `home` is this computer's home folder.
export function backendOf(config = {}, home = "") {
  const command = commandWords(config.command);
  const on = `${config.on ?? ""}`.trim() || null;
  return {
    command,
    on,
    local: `${config.local ?? ""}`.trim() || null,
    by: config.by || "user",
    projects: config.projects || `${home}/projects`,
    // Where a session on this computer starts when the store's projects folder is on another machine.
    localProjects: on ? home : config.projects || `${home}/projects`,
  };
}

// The command as words: a string is one program (an absolute path, or a name on PATH), as install.mjs writes it; a
// list is a program and its fixed arguments (["hub", "channels"]).
export function commandWords(command) {
  if (Array.isArray(command)) {
    const words = command.map((w) => `${w}`).filter(Boolean);
    return words.length ? words : ["channels"];
  }
  return [`${command ?? ""}`.trim() || "channels"];
}

// A word for a shell line, quoted so nothing in it is read as shell.
export const sq = (s) => `'${`${s}`.replace(/'/g, `'\\''`)}'`;

// The shell line's start: PATH, and a `channels` function that runs the command. A store on another machine gets
// that machine's ~/.local/bin first: a shell Herdr starts there has a short PATH, and that's where Claude Code and
// a hub's command are.
export function shellPrelude(backend) {
  const path = backend.on ? 'PATH="$HOME/.local/bin:$0:$PATH"' : 'PATH="$0:$PATH"';
  return `${path}; channels() { ${backend.command.map(sq).join(" ")} "$@"; }; `;
}

// What this computer is called in the store, given what `channels list --json` said (`data`). A store on this
// computer says so itself; one on another machine says its own name, so the setting is all there is.
export function localName(backend, data) {
  if (backend.local) return backend.local;
  return backend.on ? null : data?.machine ?? null;
}

// The Herdr machine a task runs on: null is this computer, a name is a machine Herdr knows (`known`: the names from
// machines()), and undefined is one this computer can't reach. `data` is what `channels list --json` said.
export function herdrMachine(task, { backend, data, known = [] }) {
  if (task?.machine === "cloud") return null; // opened here: in a terminal when it attaches, else on claude.ai
  const here = localName(backend, data);
  if (task?.machine === here) return null;
  if (!backend.on) return undefined; // a store on this computer files only this computer's tasks
  // The store's own machine, by the name the store gives it, is the machine its command runs on.
  if (task?.machine && task.machine === data?.machine) return backend.on;
  return known.includes(task?.machine) ? task.machine : undefined;
}

// What a channels command can do, beyond the commands every one has (list, create, rename, icon, move, archive,
// describe, file, dismiss, chat <name>):
// - chat-bg: `chat <name> --bg --json`, the chat in a background terminal the mod shows as a tab
// - seen: `seen <task>`, and an unread dot on a task with an event not seen yet
// - routines: `routine …`, and `routines` on each channel
// - rename-task: `rename-task <task> <name>`
// - refresh: `refresh --json`, and `updates` in the list
export const ALL_FEATURES = ["chat-bg", "seen", "routines", "rename-task", "refresh"];

// The features, from `list --json`: its `features` when it gives them. This repo's command from before it listed
// them is known by its `remote_control` field, and had them all; any other command (a hub that lists none) has none.
export function featuresOf(head) {
  if (Array.isArray(head?.features)) return head.features.filter((f) => typeof f === "string");
  if (head && typeof head.remote_control === "boolean") return [...ALL_FEATURES];
  return [];
}

// The standing of each task comes from `claude agents --json` on the machine it runs on. `lists` is machine name ->
// that machine's list (parsed JSON, or text); `fallback` is used for a task whose machine has no list (a store on
// this computer reads only this computer's, whatever the task's machine is called).
export function agentIndex(text) {
  const by = new Map();
  let list = text;
  if (typeof text === "string") { try { list = JSON.parse(text); } catch { list = []; } }
  for (const a of Array.isArray(list) ? list : []) { if (a?.sessionId) by.set(a.sessionId, a); if (a?.id) by.set(a.id, a); }
  return by;
}
export function agentOf(task, indexes, fallback = null) {
  const by = indexes[task.machine] ?? fallback;
  return by ? by.get(task.session_id) ?? by.get(task.job) ?? null : null;
}

// How the sidebar's footer names the store's machine and its link: Herdr's machines() entry for it.
export function linkState(backend, machineList = [], error = null) {
  if (error) return "unreadable";
  if (!backend.on) return "here";
  const m = machineList.find((x) => x.name === backend.on);
  return !m || m.layout === "unavailable" ? "unreachable" : m.layout === "ready" ? "connected" : "connecting";
}

// The keys this mod keeps in herdr's shared state are its folder's name and a word ("channels.data"), so two copies
// installed side by side (mods/channels and mods/channels-hc) never read each other's.
export const keyOf = (mod, word) => `${mod || "channels"}.${word}`;
