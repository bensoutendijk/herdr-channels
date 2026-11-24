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
// - update: `update --bg --json` installs the latest herdr-channels release, and `updates.release` in the list
// - routine-edit-on: `routine edit … --on|--off` saves a routine's fields and its switch in one write; without it
//   the dialog saves with edit, then on or off
// - routine-manual: `routine add|edit … --schedule manual`, a routine with no time that runs only when run
// - routine-dry-run: `routine add|edit … --dry-run` prints what it would set up without saving (for the chat; the
//   mod doesn't use it)
// - routine-status: `status` ({ state, words, at }) and `paused` on each routine, `last.waiting` as { why, since },
//   and `timer` ({ last_tick_at, stale, hint }) in the list
// - routine-by: `routine run|on|off|edit … --by <who>`, so the store says who asked
// - harnesses: tasks on more than one coding agent (Claude Code, Codex): `harnesses` in the list and in capabilities,
//   `harness`, `standing` and `caps` on a task not on Claude Code, `harness` on each channel, `start --harness`,
//   `harness <channel> --tasks`, `approve <task> allow|deny`
// - send-by: `send <task> --by user`, a message the user sent from the panel: the chat doesn't hear how that turn ends
// - gate: the notice gate: `viewing <task>|--none` and `notify <channel>`
export const ALL_FEATURES = ["chat-bg", "seen", "routines", "rename-task", "refresh", "update", "routine-edit-on", "routine-manual", "routine-dry-run", "routine-status", "routine-by", "harnesses", "refresh-all", "send-by", "gate", "chat-harness"];
// What this repo's command could do before it listed its features.
const UNLISTED = ["chat-bg", "seen", "routines", "rename-task", "refresh"];

// The features, from `capabilities --json` ({ features: [...] }): null when it isn't that (an older command, which
// doesn't know the question), so the list's answer stands.
export function capabilitiesOf(text) {
  try {
    const out = JSON.parse(`${text ?? ""}`.trim());
    return Array.isArray(out?.features) ? out.features.filter((f) => typeof f === "string") : null;
  } catch { return null; }
}

// The zone routine times are in, from `capabilities --json` ({ clock: { tz } }): null when the command doesn't say.
export function clockOf(text) {
  try {
    const tz = JSON.parse(`${text ?? ""}`.trim())?.clock?.tz;
    return typeof tz === "string" && tz ? tz : null;
  } catch { return null; }
}

// A terminal address a store on another machine gave ("t2k", that machine's own), as Herdr here names it: "server/t2k".
// One already named by machine, or any on this computer (`on` null), is kept.
export function remoteAddress(address, on) {
  if (!address) return null;
  return on && !`${address}`.includes("/") ? `${on}/${address}` : `${address}`;
}

// The features, from `list --json`: its `features` when it gives them. This repo's command from before it listed
// them is known by its `remote_control` field, and had them all; any other command (a hub that lists none) has none.
export function featuresOf(head) {
  if (Array.isArray(head?.features)) return head.features.filter((f) => typeof f === "string");
  if (head && typeof head.remote_control === "boolean") return [...UNLISTED];
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

// A task's standing: needs, working or ready. Claude Code's own list on the task's machine, when the mod read it
// (`fromAgent`), says it; otherwise the store's own `standing`, which a hub gives for every machine it reaches
// (the mod reads `claude agents` only on the store's machine and this one); otherwise ready.
export const STANDINGS = ["needs", "working", "ready"];
export function standingOf(fromAgent, fromStore) {
  return fromAgent ?? (STANDINGS.includes(fromStore) ? fromStore : "ready");
}

// Whose clock a routine keeps, in the Routines dialog's words: this computer's, or the store machine's (`on`), where
// the timer runs, and so what a missed run waited on.
// `tz` is the zone that clock keeps, when the command said (capabilities' clock.tz).
export function routineClock(on, tz = null) {
  const zone = tz ? ` (${tz})` : "";
  return on
    ? { times: `Times are ${on}'s local time${zone}.`, short: `Times are ${on}'s${zone}.`, missed: `If ${on} was off, still run it within` }
    : { times: `Times are this Mac's local time${zone}.`, short: `Times are this Mac's${zone}.`, missed: "If the Mac was asleep, still run it within" };
}

// What the catch-up window means for a run at `at` ("09:00"), in words: it still runs late until `until`, or with no
// window (`until` null) it is skipped.
export function catchupRule(on, at, until) {
  if (!at) return "";
  if (on) return until ? `If ${on} is off at ${at}, it runs when ${on} is back until ${until}, else it's skipped.` : `If ${on} is off at ${at}, that run is skipped.`;
  return until ? `If the Mac sleeps through ${at}, it runs on wake until ${until}, else it's skipped.` : `If the Mac sleeps through ${at}, that run is skipped.`;
}

// A routine's status (the store's `status`: { state, words, at }, routine-status) as a colour: "blocked" when it needs a
// look (missed, broken), "working" for a run that has waited a while or says why it waits, else null.
export function statusTint(r, now = Date.now()) {
  const st = r?.status;
  if (!st || !r.enabled) return null;
  if (st.state === "missed" || st.state === "broken") return "blocked";
  if (st.state === "waiting" && (r.last?.waiting || (st.at && now - Date.parse(st.at) > 10 * 60000))) return "working";
  return null;
}

// The sidebar clock's tint for a channel: the most urgent of its routines' (statusTint), and the routine that gives it.
export function routineTint(routines = [], now = Date.now()) {
  let out = null;
  for (const r of routines) {
    const tint = statusTint(r, now);
    if (tint === "blocked") return { tint, routine: r };
    if (tint && !out) out = { tint, routine: r };
  }
  return out;
}

// The routines timer, when its last tick (`timer` in the list, routine-status) is older than about 5 minutes: the
// dialog's line and the command that starts it again. null while it ticks, or when the backend doesn't say.
export function staleTimer(timer, now = Date.now(), hm = (iso) => iso) {
  const at = timer?.last_tick_at ? Date.parse(timer.last_tick_at) : NaN;
  if (!Number.isFinite(at) || now - at <= 5 * 60000) return null;
  return { text: `The routines timer hasn't run since ${hm(timer.last_tick_at)}, so routines won't come due.`, hint: timer.hint ?? null };
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

// What a channel has waiting for the person, for its row in the sidebar (`now` in ms):
// - needs: tasks that wait on them now (a question, a permission prompt, a Codex approval: standing "needs"). A
//   question nobody answered in two days doesn't count: its card has gone (QUESTION_TTL_MS), and the task waits on
//   in the panel. `asking` ({ state, at }, from `channels list`) says which kind and since when; a store that doesn't
//   give it has every "needs" task counted.
// - unread: other tasks with an event not seen yet (most often a finish), when the store marks tasks seen (`seen`);
//   without that, nothing would ever clear the mark, so there is none.
// - held: room for events a notice gate holds back for a catch-up. Nothing holds any yet.
// An archived channel has nothing waiting: the sidebar doesn't list it.
export const QUESTION_TTL_MS = 2 * 86_400_000;
export function agedOut(task, now) {
  // A task that asked before the store recorded `asking`: its unread mark, while there is one, says since when.
  const a = task?.asking ?? (task?.unread?.kind === "needs" ? { state: "question", at: task.unread.at } : null);
  const at = Date.parse(a?.at ?? "");
  return (a?.state ?? "question") === "question" && Number.isFinite(at) && now - at > QUESTION_TTL_MS;
}
export function waitingOf(channel, { now = Date.now(), seen = false } = {}) {
  const out = { needs: 0, unread: 0, held: 0 };
  if (!channel || channel.archived_at) return out;
  for (const t of channel.tasks ?? []) {
    if (t.dismissed) continue;
    if (t.standing === "needs" && !agedOut(t, now)) out.needs++;
    else if (seen && t.unread && t.standing !== "needs") out.unread++;
  }
  return out;
}
