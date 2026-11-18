// Whether a channel's chat is running, and what to do when it isn't. Plain functions, so the tests can run them
// without herdr (main.js does the herdr side).

// A terminal's command is a channel's chat when it ends in `chat <name>` (`… channels chat <name>`). Only the
// word is checked: a rename changes the name, not the chat.
export const runsChat = (argv) => Array.isArray(argv) && argv.length >= 2 && argv.at(-2) === "chat";

// Whether a terminal, as herdr's terminals() or `hc get --json` describes it, is a chat that is running. A chat
// that ended is gone from terminals() or finished; one herdr-core lost (an update or restart of the core, a
// reboot) is live but runs a shell in the chat's place, under the same address and name.
export const chatAlive = (term) => Boolean(term) && term.state === "live" && runsChat(term.argv);

// A chat that ends sooner than this after it started is failing to start (claude refuses its arguments, say):
// it isn't started again on its own, so it can't go round in a loop.
export const QUICK_MS = 15000;

// What to do about a chat that isn't running, given what `hc get --json` says of its last terminal (null when
// there was none, or herdr-core no longer knows it). `auto` is a restart the sidebar's timer makes on its own; a
// click on the channel always starts it again. Answers { start: true } or { start: false, message }.
export function afterEnd(info, { auto, channel, now = Date.now() }) {
  if (!auto || !info || info.state === "live") return { start: true };
  const created = Number(info.created_ms);
  const ended = Number(info.finished_ms ?? now);
  if (!Number.isFinite(created) || ended - created >= QUICK_MS) return { start: true };
  const secs = Math.max(0, Math.round((ended - created) / 1000));
  const how = info.signal != null ? `signal ${info.signal}` : info.exit_code != null ? `exit ${info.exit_code}` : "ended";
  return { start: false, message: `#${channel}'s chat stopped ${secs}s after it started (${how}).` };
}

// The last line a terminal printed, for the message: what claude said when it stopped, as a rule.
export function lastLine(text) {
  const lines = `${text ?? ""}`.split("\n").map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim()).filter(Boolean);
  const line = lines.at(-1) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
