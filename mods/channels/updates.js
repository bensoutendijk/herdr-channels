// The sidebar's refresh row: what it says, from the `updates` that `channels list --json` gives (see "updates" in
// bin/channels.mjs). Plain functions, so the tests can run them without herdr (main.js draws the row).
//
// updates: { build: { id, label } | null, claude: installed version | null, asked: version a refresh waits on | null,
//   chats: [{ channel, behind: ["channels"?, "claude"?], state: claude's status, claude: version it runs }] }
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
  const onClaude = chats.filter((x) => x.behind?.includes("claude"));
  const onBuild = chats.filter((x) => x.behind?.includes("channels"));
  if (!onClaude.length && !onBuild.length) return null;
  // What happens without a click: chats behind the build restart on their own, and so do chats behind Claude Code
  // once a refresh asked for it. One that is idle and still behind hasn't been reached yet (no timer, a draft in its
  // prompt): a click tries it now.
  const unasked = updates.asked ? [] : onClaude;
  const idle = chats.filter((x) => x.state === "idle" && (x.behind?.includes("channels") || (updates.asked && x.behind?.includes("claude"))));
  if (unasked.length || idle.length) {
    const claudeNew = unasked.length || (idle.some((x) => x.behind.includes("claude")));
    const buildNew = onBuild.length > 0;
    const title = claudeNew && buildNew ? "Updates installed" : claudeNew ? `Claude Code ${updates.claude}` : "herdr-channels updated";
    const olds = [...new Set(onClaude.map((x) => x.claude).filter(Boolean))];
    const detail = claudeNew && buildNew ? `Claude Code ${updates.claude} and herdr-channels ${updates.build?.label ?? ""}`.trim()
      : claudeNew ? `${onClaude.length === 1 ? `#${onClaude[0].channel} runs` : `${onClaude.length} chats run`} ${olds.length === 1 ? olds[0] : "an older one"}`
      : `${onBuild.length === 1 ? `#${onBuild[0].channel} runs` : `${onBuild.length} chats run`} the version before`;
    return { offer: true, title, detail };
  }
  const waiting = chats.filter((x) => x.behind?.length);
  return { offer: false, title: "Updating", detail: restarts(waiting) };
}
