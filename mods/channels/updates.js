// The sidebar's refresh row: what it says, from the `updates` that `channels list --json` gives (see "updates" in
// bin/channels.mjs). Plain functions, so the tests can run them without herdr (main.js draws the row).
//
// updates: { build: { id, label } | null, claude: installed version | null, asked: version a refresh waits on | null,
//   chats: [{ channel, behind: ["channels"?, "claude"?, "codex"?, "restart"?, "harness"?], state: its agent's status,
//   claude: version it runs, codex: the Codex version a Codex chat runs }], harnesses: { claude, codex } }
//   ("restart": a restart of every chat was asked for, Refresh all chats, and this one hasn't restarted yet; "harness":
//   the channel now runs its chat on another harness; "codex": a Codex chat runs an older Codex than is installed)
//
// Answers null when no chat is behind (no row), else { offer, title, detail }: `offer` puts the Refresh button on it,
// for something a click would do now; without it the row only says what is still to happen on its own.

const names = (xs) => {
  const n = xs.map((x) => `#${x.channel}`);
  return n.length <= 1 ? n.join("") : n.length <= 3 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : `${n.length} chats`;
};
const restarts = (xs) => `${names(xs)} ${xs.length === 1 ? "restarts when its turn ends" : "restart when their turns end"}.`;

export function refreshRow(updates) {
  const chats = updates?.chats ?? [];
  // A chat behind its agent: Claude Code, or Codex for a Codex chat. Both are refreshed by the same click.
  const onClaude = chats.filter((x) => x.behind?.includes("claude") || x.behind?.includes("codex"));
  const onBuild = chats.filter((x) => x.behind?.includes("channels"));
  const onAll = chats.filter((x) => x.behind?.includes("restart") || x.behind?.includes("harness"));
  if (!onClaude.length && !onBuild.length && !onAll.length) return null;
  // What happens without a click: chats behind the build restart on their own, and so do chats behind Claude Code
  // once a refresh asked for it. One that is idle and still behind hasn't been reached yet (no timer, a draft in its
  // prompt): a click tries it now.
  const asked = (x) => (x.behind?.includes("codex") ? updates.asked_codex : updates.asked);
  const unasked = onClaude.filter((x) => !asked(x));
  const idle = chats.filter((x) => x.state === "idle" && (x.behind?.includes("channels") || (asked(x) && (x.behind?.includes("claude") || x.behind?.includes("codex")))));
  if (unasked.length || idle.length) {
    const claudeNew = unasked.length || (idle.some((x) => x.behind.includes("claude") || x.behind.includes("codex")));
    // The agent named: Codex when every chat behind one is a Codex chat, else Claude Code.
    const codexOnly = onClaude.length > 0 && onClaude.every((x) => x.behind.includes("codex"));
    const agent = codexOnly ? `Codex ${updates.harnesses?.codex ?? ""}`.trim() : `Claude Code ${updates.claude}`;
    const buildNew = onBuild.length > 0;
    // The build is herdr-channels', or the store's own command's when it is on another machine (its `name`).
    const product = updates.build?.name ?? "herdr-channels";
    const title = claudeNew && buildNew ? "Updates installed" : claudeNew ? agent : `${product} updated`;
    const olds = [...new Set(onClaude.map((x) => (x.behind.includes("codex") ? x.codex : x.claude)).filter(Boolean))];
    const detail = claudeNew && buildNew ? `${agent} and ${product} ${updates.build?.label ?? ""}`.trim()
      : claudeNew ? `${onClaude.length === 1 ? `#${onClaude[0].channel} runs` : `${onClaude.length} chats run`} ${olds.length === 1 ? olds[0] : "an older one"}`
      : `${onBuild.length === 1 ? `#${onBuild[0].channel} runs` : `${onBuild.length} chats run`} the version before`;
    return { offer: true, title, detail };
  }
  const waiting = chats.filter((x) => x.behind?.length);
  return { offer: false, title: onClaude.length || onBuild.length ? "Updating" : "Refreshing", detail: restarts(waiting) };
}

// The release row, above the refresh row: a newer herdr-channels release than this Mac runs, from `updates.release`
// (see bin/release.mjs), or an update running or just done. `remote`: this install is the mod only, for a store on
// another machine, so an update reloads the mod and restarts no chat. null when there is none; else { state, title, detail,
// button, notes }: `state` says how to draw it (offer, running, failed, done), `button` is the button's word (Update,
// Retry; null otherwise), and `notes` the release notes' link.
export const DONE_MS = 60000; // how long "Updated to X" stays
export function releaseRow(release, now = Date.now(), { remote = false } = {}) {
  if (!release) return null;
  const u = release.update;
  const after = remote ? "The mod reloads; chats keep running." : "Chats restart once they are idle.";
  if (u?.state === "done" && !release.available && now - Date.parse(u.at) < DONE_MS) return { state: "done", title: `Updated to ${u.to}`, detail: u.message?.replace(/^Updated to \S+\.\s*/, "") || after, button: null, notes: release.url ?? null };
  if (u?.state === "running") return { state: "running", title: `Updating to ${u.to ?? release.latest ?? "the latest release"}…`, detail: `Installing. ${after}`, button: null, notes: null };
  if (!release.available) return null;
  const notes = release.url ?? null;
  if (u?.state === "failed" && (!u.to || u.to === release.latest)) return { state: "failed", title: `Update to ${release.latest} failed`, detail: u.message ?? "It stopped before it finished.", button: "Retry", notes };
  return { state: "offer", title: `herdr-channels ${release.latest} available`, detail: release.current ? `This Mac runs ${release.current}.` : "This Mac runs a version from before releases.", button: "Update", notes };
}

// The installed version for the sidebar's footer: "v1.2.0", "v1.2.0+3.gabc1234"; null when it isn't known.
export const versionLabel = (version) => (/^\d+\.\d+\.\d+/.test(`${version ?? ""}`) ? `v${version}` : null);
