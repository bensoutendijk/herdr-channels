# Harnesses: Codex beside Claude Code

herdr-channels runs every task and every chat on Claude Code today. This is the design for a harness layer that
lets a task, or a channel's chat, run on another coding agent too, starting with OpenAI's Codex CLI.

**Built so far:** phase 1, the seam. `bin/harness/index.mjs` names the harnesses and `bin/harness/claude.mjs` holds
everything Claude Code-specific about tasks (start, the records a look reads, read, send, rename, find), behind the
interface below; the listener, `list`, `read`, `send` and `rename-task` go through it. Two things differ from the
sketch below: a harness's look is split into `scan` (once a tick) and `look` (per task, giving the Snap) plus
`withLast` (its last message, read only when there is news), and cloud tasks stay in `bin/channels.mjs` and
`bin/cloud.mjs` for now, as the Claude harness's placement in all but file.

Phase 2, Codex tasks, is built too: `bin/harness/codex.mjs` and `bin/codex-rpc.mjs` (§3), the panel's harness mark,
New session menu and "Tasks run on", Allow / Deny approval cards, `install.mjs --codex`, and the README's "Codex
tasks". Differences from §3: a look uses `thread/read` per open task (not `thread/list`, which pages through every
thread the user has); a Codex task's notices say "Task", like a Claude Code one's, and its card names the harness
("Codex asks"); a live approval keeps the Claude Code rule for prompts (a card and ride-along, no notice); the panel
marks only the non-Claude rows of a mixed channel; and the panel's New Codex session is an empty thread
(`start --empty`) opened with `codex resume`. Checked live with a real model in `dev/sandbox`, and on a remote-control
paired daemon (risk 8, below).

It was checked on 2026-11-22 against Codex CLI 0.171.0 (the current release) and Claude Code 2.1.330, on macOS,
in two rounds. The first ran Codex in a sandbox `HOME` against a small local stand-in for the OpenAI Responses API
that answers with scripted turns. That covered everything around the model: sessions, the daemon, approvals,
hooks, Herdr's view of the terminal. The second round re-ran it with a real model: a ChatGPT Plus login (model
`gpt-6.2-sol`, Codex's default) in the same kind of sandbox, built by `dev/sandbox` (see the README's
Development section), across 35 real sessions. [What a real model changed](#10-what-a-real-model-changed) has
the evidence. Each recommendation below says whether the real run **confirmed** or **changed** it.

**Short answer: go, with four changes from the real run.** The owner's decisions on them are in
[Decided](#decided).
- Codex tasks fit the task model well: Codex 0.171 keeps sessions in a local daemon of its own, much as
  `claude --bg` does. Its protocol starts a task with no terminal, reports each task's state (including "waiting
  on an approval"), sends it messages (queued while it works), renames it, and lets a terminal open it live
  mid-turn. All of that held with a real model.
- A Codex chat is viable too: a notice can start a turn in an idle chat, or queue behind a busy one, without
  typing into its terminal, and routines can queue into it. What's lost: notices show as a user message rather
  than Claude Code's faded one-line event, and there are no task cards.
- Changed by the real run:
  1. **Questions.** Without help, a real Codex turn that asks something usually adds a sentence after its
     question, so "the last line ends with ?" caught only 1 of 5 questions. With one sentence in the task's
     developer instructions about how to end a question, it caught 9 of 9 (§3).
  2. **Approvals answered from a card** move from phase 5 into phase 2. A pending approval is replayed to any
     client that connects later, and answering it over the protocol worked end to end, with the task's open
     terminal following along (§3).
  3. **The chat's hook-trust prompt** comes once per machine and Herdr shows it as no status. The real run
     suggested dropping the hook for `thread/inject_items`, but **the owner decided to keep the hook**: the listener
     answers "Trust all" once, and the README says so (§4).
  4. **The folder-trust dialog** never shows for a task. It shows only for a fresh Codex terminal in an
     untrusted folder, and channels doesn't answer it.
- Recommended order, unchanged: the harness seam first, with Claude Code only and no change in behaviour. Then
  Codex **tasks**, driven from the existing Claude Code chat. Then a Codex **chat**. Then the hub's parity.

## Contents

1. [What was tested](#1-what-was-tested)
2. [The harness interface](#2-the-harness-interface)
3. [Codex tasks](#3-codex-tasks)
4. [A Codex chat](#4-a-codex-chat)
5. [Feature by feature](#5-feature-by-feature)
6. [Choosing a harness](#6-choosing-a-harness)
7. [Store, JSON and the hub](#7-store-json-and-the-hub)
8. [Risks and open questions](#8-risks-and-open-questions)
9. [Phases](#9-phases)
10. [What a real model changed](#10-what-a-real-model-changed)

## 1. What was tested

| Question | Result | How |
| --- | --- | --- |
| Codex in a herdr-core terminal | **Works** | `hc run --bg -- codex -a never -s workspace-write "<brief>"`. Herdr tags the terminal `agent: "codex"` |
| Herdr's view of a Codex terminal | **Reliable** for working, done and blocked | `hc get --json` gave `status {app: codex, state: working}`, then `done` when the turn ended (and `turn` went up), and `{state: blocked, kind: permission}` at an approval prompt. Codex's folder-trust dialog showed as `status: null`, not blocked |
| A thread outlives its terminal | **Yes** | The TUI is a client of a shared daemon (`codex app-server --listen unix:// --managed-daemon`) that Codex starts by itself. After `hc kill` on the terminal, the daemon kept the thread |
| Start a task with no terminal | **Works** | Over the daemon's control socket: `thread/start` (folder, sandbox, approval policy, developer instructions), `thread/name/set`, `turn/start`. The client disconnected at once; the turn finished, and the session file recorded the last message |
| A task's state | **Works** | `thread/list` and `thread/read` give `status`: `idle`, `active` (with flags `waitingOnApproval` or `waitingOnUserInput`), `notLoaded` or `systemError`, plus its name, folder and session file |
| A message to a task later | **Works** | `turn/start` on an idle thread; `codex queue --thread <id> --message <text> --resume` from the command line, also on a thread no client had loaded |
| Answer an approval | **Works** in the task's terminal, and over the protocol | `hc keys <t> y` on Codex's "Would you like to run the following command?". With a real model: `item/commandExecution/requestApproval` answered `accept` or `decline` from a client that connected after the prompt appeared; the open terminal's prompt cleared and the turn went on |
| Open a task live, mid-turn | **Works** | `codex resume <id>` in a terminal attached to the daemon's running thread and showed "Working (5s • esc to interrupt)" |
| Rename a task | **Works** | `thread/name/set`; the name shows in the TUI, in `thread/list` and in `~/.codex/session_index.jsonl` |
| A notice into an idle Codex chat | **Works** | `turn/start` from outside, on the thread a TUI shows: the TUI showed it as `› [task notice] …` and took a turn on it |
| A notice into a busy Codex chat | **Works** | `thread/queue/add` during a turn: it ran by itself once the turn ended. `turn/start` during a turn was folded into the running turn instead |
| Ride-along context | **Works** two ways | A `UserPromptSubmit` hook's `additionalContext` reached the turn (after a one-time trust prompt). `thread/inject_items` added a developer message that the next turn sees, and started no turn |
| A chat's own settings, leaving the user's config alone | **Works** | A per-chat `codex app-server --listen unix://<socket> -c developer_instructions=… -c hooks.UserPromptSubmit=[…]`, with the TUI attached by `codex --remote unix://<socket> [resume <id>]`. Restarting the TUI on the same thread worked |

Two traps found on the way. The daemon's control socket speaks WebSocket over the unix socket: `codex app-server
proxy` passes bytes straight through, and plain JSON lines got no answer. A WebSocket handshake and frames,
about a hundred lines of Node with no dependencies, worked. Also, Codex keeps no record of a pending approval in
its session file: approval requests are never written there, so "waiting on you" comes from the daemon's
status or from Herdr, not from the file.

## 2. The harness interface

### Where Claude Code is built in today

Every one of these was checked in the code:

| Area | Claude Code specifics | Where |
| --- | --- | --- |
| Start a task | `claude --bg -n <name> [--permission-mode] [--model] [--remote-control] <brief>`; the job id parsed from its output, the session id from `~/.claude/jobs/<job>/state.json` | `start`, `bin/channels.mjs` |
| A task's state | `~/.claude/jobs/*/state.json` (state, needs, name, `nameSource`, timeline length) and `~/.claude/sessions/<pid>.json` (busy, idle, waiting) | `readJobs`, `readLive`, `stateOf` |
| Its messages | Transcript JSONL under `~/.claude/projects` | `parseTranscript`, `findTranscript`, `transcriptTitle` |
| Send | `claude stop`, wait for the process, `claude --bg --resume <id> <text>`; a copy filed when Claude Code starts one | `send` |
| Rename | Writes the job's `state.json` (`nameSource: "user"`) and reads it back | `renameJob`, `renameTask` |
| Find a session | `claude agents --json --all`, jobs, transcripts | `findLocalSession`, `listAgents` |
| The chat | `claude --session-id/--resume -n #<name> --append-system-prompt … --settings {…UserPromptSubmit hook…} --plugin-dir <cards> --mcp-config <notices> --dangerously-load-development-channels` | `chatArgs`, `chatSettings`, `noticeArgs`, `chat` |
| Notices | A Claude Code channel (MCP `notifications/claude/channel`), confirmed in the transcript, typed in after a minute | `noticeServer`, `settleNotices` |
| Refresh | Idle from `~/.claude/sessions`, the Claude Code version, the `❯` prompt on screen, SIGTERM to `claude` | `updateStatus`, `promptDraft`, `restartChat` |
| The chat's prompt | "You are one long-lived Claude Code session…" | `chatPrompt` |
| Panel standing and names | `claude agents --json` beside `channels list --json` | `readStore`, `mods/channels/main.js` |
| Open a task | `viewer.py` around `claude attach <job>`; `claude --resume` for a task with no job | `openTask`, `mods/channels/viewer.py` |
| New session | `claude --bg [--remote-control]`, then `channels file` | `startFresh`, `mods/channels/main.js` |
| Task cards | A Claude Code plugin drawn above the chat's prompt | `mods/claude` |
| Claude-only features | Remote Control (#22), cloud tasks (#23, `bin/cloud.mjs`), rename-task (#16), the Claude Code version in the Refresh row (#24) | spread through all of the above |

Cloud tasks already behave like a second harness hidden inside the first: the listener has a local loop and a
cloud loop that turn different sources into the same events, and the store marks a cloud task with machine
`cloud`. The design below makes that seam explicit and gives it a name.

### The interface

One module per harness under `bin/harness/`, plain functions with no state, so the tests run them against
fixtures as they run `parseTranscript` today:

```js
// bin/harness/<id>.mjs
export default {
  id: 'codex',                 // stored on tasks and chats; 'claude' when absent
  label: 'Codex',
  caps: {                      // what the mod and the chat's prompt may offer
    rename: true, remoteControl: false, cloud: false,
    sendWhileWorking: 'queue', // 'refuse' (Claude Code) | 'queue'
    question: 'heuristic',     // how a turn that asks something is known: 'job' (Claude Code) | 'heuristic'
    copies: false,             // whether send can start a copy (Claude Code: true)
    chat: true, cards: false, notices: 'turn', // 'channel' (Claude Code) | 'turn' | 'typed'
  },
  installed({ deps }),         // → { version } | null: the binary, and whether it can run here
  start({ deps, cwd, brief, name, model, mode }),           // → { session_id, job? }
  scan({ deps }),              // → Map<session_id, Snap>: one cheap look at every session
  read({ deps, id, limit }),   // → { title, cwd, thread, last }: as parseTranscript gives
  send({ deps, id, text }),    // → { delivered_as: 'resumed' | 'queued' | 'copy_started', copy? }
  rename({ deps, id, name }),  // → true when the harness holds the name
  find({ deps, id }),          // → { session_id, job, name, cwd } for `channels file`
  openArgv(task),              // → the program that shows the session live in a terminal
  chat: { argv, idle, notify, draft, confirm, restart }, // see §4
};

// Snap: what the listener and `list` need, in channels' own words.
// { state: 'working' | 'waiting_on_job' | 'waiting_on_user' | 'blocked' | 'failed' | 'done' | 'paused',
//   doing, waiting, prompt, name, named_by_user, work, updated_at, cwd, last_fp?, remote_url?, version? }
```

`work` is any value that changes when the session did more work (Claude Code: its timeline's length; Codex: the
count of completed turns in its session file, or the thread's `updatedAt`). The listener's dedupe (`told`,
`eventKey`, `isRepeat`) only compares it, so it stays as it is.

### How each one implements it

| Method | Claude Code (`bin/harness/claude.mjs`, moved out of `channels.mjs`) | Codex (`bin/harness/codex.mjs` + `bin/codex-rpc.mjs`) |
| --- | --- | --- |
| `installed` | `installedClaude` | `codex --version`, remembered per binary as for Claude Code; `codex app-server daemon version` says whether the daemon runs |
| `start` | `claude --bg -n …` | Over the daemon: `thread/start {cwd, sandbox, approvalPolicy, model, developerInstructions, config}`, `thread/name/set`, `turn/start {input: brief}` |
| `scan` | `readJobs` + `readLive` + `stateOf` | `thread/list` (one call, every thread with its status), and a short read of the session file's tail for threads in a channel |
| `read` | `parseTranscript` | The session file: `response_item` messages (user and assistant, skipping developer messages and `<environment_context>`), `function_call` as tool runs, the last `task_complete.last_agent_message` as `last` |
| `send` | stop, wait, `claude --bg --resume`, maybe a copy | Idle: `thread/resume` when not loaded, then `turn/start`. Working: `thread/queue/add`. Waiting on an approval: refused, as for Claude Code |
| `rename` | `renameJob` (write and read back) | `thread/name/set` |
| `find` | jobs, `claude agents`, transcripts | `thread/list` by id or name; `session_index.jsonl` for a name |
| `openArgv` | `viewer.py` around `claude attach <job>` | `codex resume <id>` (on the shared daemon); `viewer.py` takes the argv to run instead of hard-coding `claude attach` |

`bin/codex-rpc.mjs` holds every call to Codex's app-server, as `bin/cloud.mjs` holds every call to Claude Code's
private sessions API: the WebSocket client, `initialize`, and one function per method. When Codex changes its
protocol, only that file changes. The Codex harness also has a fallback for when the daemon can't be reached
(see [Risks](#8-risks-and-open-questions)): it runs the task in a herdr-core terminal instead, with state from
Herdr's status and the session file.

### What stays harness-neutral

- **The store** (`channels.json`, descriptions, the inbox, the notices queue, routines, locks) and every
  command that only touches it: create, rename, move, icon, describe, archive, dismiss, seen, watch, file,
  open.
- **The listener's loop** (`listenTick`): for each open task it asks the task's harness for a `Snap`, then does
  what it does now. A finish becomes a notice; a question becomes a card and rides along, or wakes the chat
  when the chat registered for it. Dedupe and the unread dot work the same. The cloud loop becomes the Claude
  harness's cloud placement and keeps its own poll.
- **Notices** as data: `queueNotice`, `takeNotices`, `noticeText`. Only *delivering* one is the chat harness's
  (`chat.notify`).
- **Routines**: `bin/routines.mjs`, `bin/schedule.mjs`, the tick and the queue. Only typing a run into the chat
  is the chat harness's.
- **Refresh**: the lock, the build comparison and the "restart only when idle with an empty prompt" rule. The
  chat harness answers "idle?", "draft?" and "restart".
- **Cards**: the inbox entries and `cardOf` and `optionsOf` stay neutral. The cards mod draws them above a
  Claude Code chat's prompt whatever harness the *task* runs, and its Answer goes through `channels send`, so
  it reaches a Codex task with no change.
- **The herdr mod**: the sidebar, the routines dialog, the Refresh and Update rows. The tasks panel shows what
  `channels list --json` gives (§7).

## 3. Codex tasks

**Started**: in the user's shared Codex daemon, the one Codex's own TUI starts and uses, so a Codex task is as
much a Codex session as one the user started. It shows in `codex resume`'s picker, in `codex agents` and in
the Codex app. `channels start <channel> --harness codex [--repo] [--name] [--model] [--permission-mode] <brief>`:

1. Make sure the daemon runs (`codex app-server daemon start`; quick when it already does).
2. `thread/start` with the folder, the sandbox and approval policy from `--permission-mode`, developer
   instructions (the question rule below), and `config: {project_doc_fallback_filenames: ["CLAUDE.md"]}`:

   | `--permission-mode` | Codex |
   | --- | --- |
   | (none), `default` | `workspace-write` sandbox, approvals `on-request` (Codex's own default) |
   | `auto` | `workspace-write`, approvals routed to Codex's automatic reviewer (`approvalsReviewer`, as `--approve-for-me`) |
   | `plan` | `read-only`, `on-request` |
   | `bypassPermissions` | `danger-full-access`, `never` |

   The thread keeps these settings, so `send` passes none: unlike `codex exec resume`, which takes the settings
   of the command that resumes it, a turn started over the daemon keeps the thread's settings.
3. `thread/name/set` with the task's name (Codex otherwise names a thread after its first prompt).
4. `turn/start` with the brief. The brief, the repo's `AGENTS.md` (or its `CLAUDE.md` when it has no
   `AGENTS.md`) and the question rule are all the task gets.

All three reached real tasks as intended: a marker asked for in `AGENTS.md`, in `CLAUDE.md` with the fallback,
and in the developer instructions each showed in the reply. `CLAUDE.md` without the fallback was not read, and
with both files present `AGENTS.md` won (the fallback is used only when `AGENTS.md` is missing). *Confirmed.*

In practice, Codex's default (`workspace-write`, approvals on request) asked for approval only to leave the
sandbox: network access (`curl`), and once to rename the repo's own folder, which lies outside the writable
roots. Edits, `node`, `npm test` and git in the repo ran without asking, across 32 tasks. *Confirmed.*

It is filed as `<machine>/<thread id>` with `harness: "codex"`. Codex thread ids are UUIDs like Claude Code's
session ids, so the store keeps the harness on the task rather than guessing it from the id.

**Tracked**: the listener asks the Codex harness for a `Snap` of each open Codex task: one `thread/list` call for
every thread, then the session file's tail for the threads that changed.

| Codex | channels state | Event |
| --- | --- | --- |
| `active`, no flags | working | none |
| `active`, `waitingOnApproval` | waiting_on_user, a prompt | needs: a "prompt" card with the command and Codex's reason, and Allow / Deny |
| `active`, `waitingOnUserInput` | waiting_on_user, a question | needs: a question card (Codex's `request_user_input`; only in its Plan mode today) |
| `idle`, last turn ends asking something | blocked | needs: a question card with its options (see below) |
| `idle`, last turn complete, nothing queued | done | done: a notice |
| `idle`, last turn failed or aborted (`task_complete.error`, `turn_aborted`) | failed | done |
| `notLoaded`, last turn started but never completed | paused | none (the daemon stopped mid-turn) |
| `systemError` | failed | done |

Claude Code says itself when a job ended its turn asking something (its `blocked` state). Codex has no such
signal in its default mode: the turn just ends (`request_user_input` exists only in its Plan mode). The real run
measured three ways to tell (§10):

- **The bare heuristic** (last line ends with "?", or `optionsOf` finds options): over 14 varied prompts, 5
  turns asked something and the heuristic caught 1. Codex tends to ask, then add a sentence ("Please give me the
  paths…", "I'll wait for your choice before writing it."). No false positives.
- **The heuristic plus one rule in the developer instructions** (*recommended*): "If you cannot go on without
  the user's decision or information, stop and make your final message end with that one question as its own
  last line, ending in a question mark… Never end a finished task's message with a question." Over 9 prompts (6
  that asked, 3 that finished): 9 of 9 right, no false positives.
- **`outputSchema` on each turn** (Codex's structured output): `{status: done | needs_user, message, question,
  options}`. 4 of 4 right, and it even offered options. But the final message *is* that JSON, so the task's
  terminal shows JSON, and every `send` has to pass the schema again. Kept as the fallback if the rule drifts.

So a Codex task carries the rule, and a turn counts as a question when its last line ends with "?" or its
message ends with options. *Changed* (the rule is new; the heuristic alone isn't enough).

A finished turn followed at once by a queued message reads `idle` for a moment before the next turn starts. The
listener calls it done only when `thread/queue/list` is empty too.

**Answered**: an answer from a card, or from the chat with `channels send`, goes through `send`. A question
(the turn is over) takes `turn/start`, and the task continues. An approval prompt is answered from its card:
the listener keeps a client connected to each Codex task's thread (`thread/resume` subscribes it), and Codex
sends that client the pending `item/commandExecution/requestApproval` (or `fileChange`, `permissions`) even
when it connected after the prompt appeared. Allow and Deny on the card answer it (`accept`, `decline`), and
the turn goes on; a task's terminal, if one is open on it, clears its prompt by itself. Claude Code tasks don't
have this. *Changed:* this was phase 5, and it moves into phase 2. `channels send` to a task waiting on an
approval still says to answer the approval.

**Sent to while working**: Codex queues safely (`thread/queue/add` runs once the turn ends, tested), so a message
to a working Codex task is queued and the reply says so, instead of being refused as it is for Claude Code.
There are never copies: `delivered_as` is `resumed` or `queued`, and the copy-filing path stays Claude Code's.
With a real model: a message queued during a turn ran as the next turn, by itself. *Confirmed.*

**Resumed**: nothing extra to do, since the daemon holds the thread. A thread the daemon unloaded (it unloads
idle threads a minute after their last client leaves) is loaded again by `thread/resume` before the turn. With a
real model, a task left `notLoaded` for about 15 minutes took its answer and finished over two more turns.
*Confirmed.*

**In the panel**: `channels list --json` gives each Codex task a `standing` (needs, working, ready) from the same
scan. The mod already takes a store's `standing` for tasks whose machine it has no `claude agents` list for
(`standingOf`), so it needs only a small change: use `standing` for any task whose `harness` isn't `claude`. The
row shows the task's name as Codex has it, and a small harness mark (§6).

**Opened**: the panel runs `codex resume <id>` in a herdr-core terminal, through `viewer.py` with that argv in
place of `claude attach`. The TUI attaches to the daemon's thread (tested mid-turn), and leaving it leaves the
thread running, like detaching a Claude Code job.

**Cards**: the same inbox entries, so a Codex task's question shows as a card above a Claude Code chat's prompt,
with options when its message lists them, and Answer reaches the task through `channels send`. Its Open opens
the task in the panel as above. A card says which harness the task runs in its subtitle ("Codex · logo-pass").

## 4. A Codex chat

**Viable, yes.** Everything a chat needs was tested, but it runs differently from a Claude Code chat, and two
things are lost.

### How it runs

```
herdr-core terminal chat-<channel id>
└─ /bin/sh restart loop → channels chat <name>
   ├─ codex app-server --listen unix://<store>/codex-<channel id>.sock     the chat's own server, with its settings
   │    -c developer_instructions="<chat prompt>"                           (never the user's config files)
   │    -c hooks.UserPromptSubmit=[{… "channels pending --hook" …}]
   ├─ codex --remote unix://<that socket> resume <thread id>                the TUI the user types into
   └─ the listener, a client of that socket                                 notices, routines, idle checks
```

The chat gets its own app-server so its settings (the chat's prompt) reach only it, as `--settings`
and `--append-system-prompt` do for a Claude Code chat. (Per Codex's source, a TUI started with its own `-c` settings
doesn't use the shared daemon but runs a server of its own, so the chat's server is made explicit.) The thread itself is an ordinary Codex session in
`~/.codex`, so the chat resumes on it after a restart, and the user can open it in Codex's own tools.

### How things reach it

| What | Claude Code chat today | Codex chat |
| --- | --- | --- |
| A task finished (notice) | Pushed through the notices channel: one faded `← tasks: …` line, then a short turn once idle | `turn/start` with a one-line `[task notice] …` when the chat is idle; `thread/queue/add` while a turn runs, which runs after it. The RPC's answer confirms delivery, so there is no transcript matching and no typed fallback |
| Ride-along news | The `UserPromptSubmit` hook (`pending --hook`) | The same hook and command, in Codex's hook format (its output is the same JSON shape), trusted once (below). Fallback until it's trusted: `thread/inject_items` as each event arrives |
| A wake (a registered question) | Typed into the terminal with `hc send` | `turn/start` or `thread/queue/add`, as a notice |
| A routine | Typed in with `hc send` | `thread/queue/add`: it waits for any turn in progress and never lands in a half-typed draft |
| Idle? (refresh, notices) | `~/.claude/sessions` status and the terminal's status | The thread's status from the chat's server, and the terminal's status |
| A draft on screen? | The `❯` line | The `›` line: empty when it shows Codex's placeholder ("Ask Codex to do anything") |
| Restart on a new build | SIGTERM to `claude`, the loop runs it again | Stop the TUI and the chat's server, and the loop runs both again on the same thread |
| The chat's prompt | `--append-system-prompt` | `developer_instructions`. The words change from "one long-lived Claude Code session" to the harness's name; the rest is the same |

Codex asks the user to trust a hook before it runs it ("Hooks need review", then "Trust all and continue"), and
records the trust by the hook's key and hash in the user's `config.toml`. In the real run, that prompt came once
per machine while the hook's command stayed the same: a second chat and a restarted chat didn't ask again, but a
changed command did. So the hook's command is kept the same for every chat (the channel comes from the
environment of the chat's server). Herdr shows the prompt as no status (`status: null`), so the listener
watches for it on the chat's screen.

**Decided: the listener answers it**, as it answers Claude Code's development-channel prompt today: once,
by choosing "Trust all and continue", and the README says so. "Trust all" also trusts any other new or changed
hook the user has at that moment; that was accepted knowingly. `hooks/list` (each hook's `trustStatus`) tells
the listener whether channels' hook is trusted. Until it is, ride-along news goes in by `thread/inject_items`,
which a real model also used (§10). The real run had recommended dropping the hook for `thread/inject_items`
alone; that is the fallback now, not the plan.

A notice started as a turn runs any hooks the user has, like a typed message.

### What's lost

- **The notice's look.** Claude Code shows a channel event as one faded line. Codex shows a `turn/start` as a
  user message (`› [task notice] The logo task finished: …`), then the chat's turn on it. It is still one line
  followed by a short reply, so close to the Duet-style notice, but heavier. No quieter way into a Codex
  thread was found: `thread/inject_items` is quiet but starts no turn.
- **Task cards.** Codex has no plugin surface above its prompt (its status-line extensions are experimental).
  In a Codex chat, a task's question shows in the tasks panel and rides along with the next message; it can't
  be answered from a card. The chat can still answer with `channels send` when the user says so.
- **Remote Control's claude.ai link** for the chat. Codex has a remote control of its own (pairing its daemon
  with the Codex app), which is a different thing (§5).

## 5. Feature by feature

| Feature | Codex tasks | Codex chat | Notes |
| --- | --- | --- | --- |
| Start, read, send, dismiss, file | Same commands | Same commands | `--harness codex` on start; `file` finds Codex threads too |
| Events (finish, question, prompt) | Same events | n/a | Question by heuristic (§3) |
| Sending while it works | **Better**: queued | n/a | `caps.sendWhileWorking` |
| Rename (`rename-task`) | **Better**: `thread/name/set`, no read-back race | n/a | `caps.rename` |
| Copies on send | None | n/a | `caps.copies` |
| Unread dots, seen | Same | n/a | |
| Task cards | Shown in a Claude Code chat | **None** | `caps.cards` on the chat's harness |
| Notices | n/a | Different look (§4) | `caps.notices` |
| Ride-along | n/a | Same hook, trusted once by the listener | |
| Routines | n/a | Same; queued rather than typed | |
| Refresh | Nothing to do (the daemon holds tasks) | Same rule, harness answers idle and draft | The row names each harness's version |
| Remote Control (#22) | **Hidden** | **Hidden** | Codex's remote control pairs the daemon with the Codex app, not a link per session. A later `caps.remoteControl: 'pairing'` could offer "Pair with the Codex app". Once paired, the shared daemon's sessions, Codex tasks included, show in the app (checked; risk 8) |
| Cloud tasks (#23) | **Hidden** | n/a | Codex Cloud has `codex cloud exec --env <id>`, `list --json`, `status`, `apply`: a later cloud placement for Codex, with its own environments |
| Approvals from a card | **Better**: Allow / Deny | n/a | Only possible with Codex; phase 2 |
| The Claude Code version in the Refresh row (#24) | — | — | Per harness: "Claude Code 2.1.331 · Codex 0.172.0", each shown when installed and used |

What's hidden is driven by the capabilities, never by `if (codex)` in the mod: the mod reads `caps` per harness
from `channels capabilities --json` (§7) and offers what the task's harness has.

## 6. Choosing a harness

- **Per task.** `channels start … --harness codex`. The tasks panel's **New session** becomes a small menu, one
  item per installed harness ("New Claude Code session", "New Codex session"), each starting a fresh session of
  that kind and filing it, as now.
- **A channel's default for tasks.** `channels harness <channel> --tasks codex` (and in the channel's ···
  menu, "Tasks run on…"). A task started without `--harness` uses it; with none set, Claude Code.
- **How the chat chooses.** The chat's prompt lists the installed harnesses and the channel's default. It starts
  a task on the default unless the user asks for another ("have Codex do it"), or the brief clearly calls for
  one the user has said they prefer. It says which it used when it reports starting the task.
- **The chat's own harness.** `channels harness <channel> --chat codex`. Changing it starts a new chat session
  on the new harness; the old one stays in its harness's history and the channel's description carries over.
  The chat records its harness (`chat.harness`). Default: Claude Code.
- **In the panel.** A row shows a small mark for its harness only when the channel has tasks on more than one,
  so a Claude Code-only channel looks as it does today. The task's header names it ("Codex · workspace-write").
- **In the installer.** `install.mjs` finds `codex` as it finds `claude`, and `--codex` / `--no-codex` turn Codex
  support on or off, as `--cloud` does. Off, nothing calls Codex, and Codex tasks already filed show their last
  known state.

## 7. Store, JSON and the hub

### The store (additive, version stays 2)

```jsonc
// a task
{ "machine": "studio", "session_id": "01a20506-…", "job": null, "harness": "codex",   // absent means "claude"
  "name": "Logo pass", "repo": "website", "folder": "…/website", "added_at": "…", "how": "started",
  "codex": { "sandbox": "workspace-write", "approval": "on-request", "model": null } }

// a channel
{ "…": "…", "harness": { "tasks": "codex", "chat": "claude" },                     // absent: Claude Code for both
  "chat": { "machine": "studio", "session_id": "…", "harness": "claude", "started_at": "…" } }
```

A store written before this reads the same, since a missing `harness` means Claude Code. An older
`channels` reading a newer store ignores the new fields, and treats a Codex task as a Claude Code session it
can't find (its state "Ended"), which is safe.

### `channels list --json` and `capabilities --json`

- Top level: `harnesses: [{ id, label, version, on, caps }]` for the harnesses installed and turned on.
- Each task: `harness`, and `standing` (needs, working, ready) for any task not on Claude Code.
- Each channel: `harness: { tasks, chat }`.
- `features` gains `harnesses`. The mod shows harness choices only when the command lists it, so a hub that
  hasn't caught up shows today's panel.
- `updates.claude` becomes `updates.harnesses: { claude: "2.1.331", codex: "0.172.0" }` (keeping `claude`
  for an older mod).

### The hub on the server

A store on another machine (a hub's `channels`-style command) keeps the same contract, so it needs:

- To accept `--harness` on start and record `harness` on tasks, and to list `harnesses`, `harness` and
  `standing`. It already gives `standing` for tasks on machines the mod doesn't read, which is the path a Codex
  task takes.
- The Codex harness module itself. Like `bin/schedule.mjs` and `bin/routines.mjs`, `bin/harness/codex.mjs` and
  `bin/codex-rpc.mjs` should have no imports outside Node, so the hub can carry verbatim copies.
- For tasks on another machine, Codex's daemon is per machine: the hub reaches it through the machine's own
  command (`hc exec --on <machine> channels codex-scan --json`), or lists those tasks with the state it last
  saw.
- A Codex chat on the server needs Codex installed and signed in there, and the hub's chat runner learns the
  per-chat app-server of §4. Its wake for Claude Code chats is unchanged.
- `capabilities --json` lists `harnesses` only once all of that is in, as with every feature so far.

## 8. Risks and open questions

### Risks

1. **Codex's app-server protocol is marked experimental**, and its WebSocket-over-unix-socket framing is
   undocumented. Codex releases often (0.171.0 came out two days before this was checked). Mitigations: every call sits in `bin/codex-rpc.mjs`. On start,
   the harness checks the protocol it needs (`initialize`, then the methods it uses, judged by their error
   codes) and turns Codex tasks off with a clear reason when that fails. Two fallbacks: `codex queue … --resume`
   (a supported command) for sending, and **terminal mode**, where the task runs `codex` in a herdr-core
   terminal and its state comes from Herdr (tested, reliable) and the session file.
2. **Daemon life.** Codex starts its daemon on demand and can update it, and `codex app-server daemon update`
   "may interrupt running work". In the real run, `codex app-server daemon stop` was gentler than feared: it
   waited about 40 seconds for a running turn to finish before stopping, and the task was complete, not cut off.
   A task that is cut off (by `update`, or the Mac sleeping) shows as paused (§3), and a message resumes it.
3. **~~Only tested against a stand-in model.~~** Settled by the real run (§10).
4. **Questions are still inferred** for Codex tasks (§3), but from a rule the task is given, which held 9 of 9.
   A wrong guess shows a finish as a question card, or the reverse; both are visible and cheap to correct. If
   the rule drifts with a new model, `outputSchema` is the stricter fallback.
5. **Folder trust lives in the user's Codex config.** The real run narrowed this: a task started over the daemon
   never shows the folder-trust dialog, even in an untrusted folder, and neither does `codex resume <id>`
   opening it in a terminal. Only a *fresh* `codex` terminal in an untrusted folder asks ("Trust this folder?"),
   and Herdr shows that as no status. That is the panel's **New Codex session** (and a Codex chat's first
   start), so those open in the projects folder, which the installer asks the user to trust once by running
   `codex` there, as it does for Claude Code. channels never answers that dialog, and never writes the trust
   itself: it is Codex's consent, and it lets the folder's own settings run code. The chat's *hook* trust is
   different: the listener answers that once (§4).
6. **~~Instructions files.~~** Settled: `project_doc_fallback_filenames = ["CLAUDE.md"]` on the thread makes a
   `CLAUDE.md`-only repo's rules reach the task, and `AGENTS.md` wins when both exist (§3).
7. **Notices look heavier** in a Codex chat (§4), against the Duet-style one-line notice the product aims for.
   Unchanged by the real run: a notice shows as `› [task notice] …` and a one-line reply.
8. **Codex's remote control shows the shared daemon's sessions on the user's phone.** With
   `codex remote-control start`, the shared daemon the Codex tasks run in is the one paired with the Codex app,
   and its sessions appear in the app on the paired phone (checked by the user after the real run). So a
   channels Codex task shows there like any Codex session the user started: it can be watched and answered
   from the phone, which is a plus, but its name and brief are visible there too. Nothing for channels to do;
   the README's Codex section should say so.
9. **A queued message briefly reads as a finish.** Between a turn and a queued message's turn, the thread reads
   `idle`. The listener checks `thread/queue/list` before calling a task done (§3).

### Open questions

Each answered by the real run (§10):

1. **Order.** Codex tasks first, driven from the Claude Code chat, and the Codex chat after? *Recommended:
   yes.* **Confirmed.** Tasks carry most of the value, risk the least, and keep cards; with approvals on cards
   (below) they now do something Claude Code tasks can't.
2. **Where Codex tasks run.** In the user's shared Codex daemon, with terminals as the fallback? *Recommended:
   the daemon.* **Confirmed.** 34 real tasks ran headless there; pending approvals reach a late client, an
   unloaded task resumes, and a stop waits for the running turn.
3. **Defaults.** Claude Code for chats and tasks unless a channel says otherwise, with a per-channel default for
   tasks? *Recommended: yes.* **Confirmed** (nothing in the run bears against it).
4. **A Codex chat at all**, after Codex tasks have been used a while? *Recommended: yes, later.* **Confirmed.**
   Real turns took notices as a turn when idle and queued behind a busy turn, so it works; it still looks
   heavier and has no cards.
5. **Questions.** A turn ending with options or a "?" counts as a question? **Changed:** not on its own (it
   caught 1 of 5). *Recommended:* give each Codex task one sentence of developer instructions on how to end a
   question, then apply the same test (9 of 9).
6. **The hook-trust prompt** answered by the listener? The real run recommended no hook at all
   (`thread/inject_items` instead), since "Trust all" also trusts the user's other new hooks. **Decided: answer
   it as first planned**, once, said in the README (§4). The folder-trust dialog is still never answered.
7. **`CLAUDE.md` for Codex tasks** as a fallback for `AGENTS.md`? *Recommended: yes.* **Confirmed**, per thread,
   never in the user's config.
8. **Codex's default permissions** (`workspace-write`, approvals on request)? *Recommended: yes.*
   **Confirmed**: in practice it asked only to reach the network or touch files outside the repo.
9. **The hub** after phase 2? *Recommended: after.* **Confirmed.** Codex is now signed in on the server too
   (a ChatGPT account), so phase 4 can be tried for real when it comes.
10. **A supervised real-login run?** **Done**, with a ChatGPT Plus login in `dev/sandbox`. Rerun it with
    `dev/sandbox up --codex real` before phase 2 and phase 3 merge.
11. **New: approvals from a card in phase 2?** *Recommended: yes* (§3). About a day more in phase 2.
12. **New: show the account's Codex usage?** `account/rateLimits/read` gives the plan's 5-hour and weekly
    windows as percentages. *Recommended: later, as a line in the Refresh row's harness list*, not in phase 2. **Decided: no.**

### Decided

The owner's answers to the four questions the real run left open (2026-11-22):

| Question | Decision |
| --- | --- |
| The "how to ask" rule in each Codex task's developer instructions (5) | **Yes** |
| Allow / Deny on Codex approval cards, in phase 2 (11) | **Yes** |
| The chat's hook-trust prompt (6) | **The listener answers "Trust all" once**, and the README says so; it also trusting the user's own new hooks is accepted. `thread/inject_items` is the fallback until it's trusted |
| Codex usage in the panel (12) | **No**: not shown, now or later |

## 9. Phases

| Phase | Size | Delivers |
| --- | --- | --- |
| 1. The seam | S (1–2 days) | `bin/harness/claude.mjs` with everything Claude Code-specific from `bin/channels.mjs`, behind the interface; the listener and `list` go through it; cloud becomes the Claude harness's placement. No behaviour change: the existing tests pass unchanged, plus tests for the interface |
| 2. Codex tasks | M–L (4–6 days) | `bin/harness/codex.mjs`, `bin/codex-rpc.mjs` (seeded by `dev/codex-rpc.mjs`); `channels start --harness codex` with the question rule and the `CLAUDE.md` fallback, read, send (queued while working), rename, file, dismiss; events and cards in the Claude Code chat; approval cards with Allow / Deny, answered by the listener's client; the panel's standing, harness mark and New session menu; `install.mjs --codex`; `harnesses` in `capabilities` and `list`; terminal mode as the fallback; a README section, and screenshots per the repo's rule |
| 3. A Codex chat | M (2–3 days) | The per-chat app-server; notices by `turn/start` and the queue; the ride-along hook, its trust prompt answered once by the listener (and `thread/inject_items` until then); routines queued; refresh for a Codex chat; the chat's prompt worded per harness; `channels harness <channel> --chat`, and the channel menu's choice |
| 4. The hub | M (2–3 days, its own repo) | §7's list, in the server's command; `capabilities` says `harnesses` once it's done |
| 5. Later, as wanted | S each | Codex Cloud as a cloud placement; "Pair with the Codex app"; Codex's `request_user_input` answered from a card |

Tasks come before the chat because they need no chat changes at all: the Claude Code chat starts, reads,
answers and hears about Codex tasks through the same `channels` commands, and its cards work for them. That
gives a usable multi-harness product after phase 2. The chat is where the harnesses differ most, so it waits
for what phase 2 teaches.

Each phase is tried with `dev/sandbox` (README, Development) before it merges: `--codex mock` for the
mechanics and the tests' fixtures, `--codex real` for one supervised run, as in §10.

### A third harness afterwards

With the seam in place, a harness is one module and its tests, plus a line in the installer. What it costs depends
on what the agent offers:

- **An agent with a daemon or an API for its sessions** (as Codex has): about the size of the Codex module,
  2–4 days: start, scan, read, send and rename against that API.
- **An agent with only a terminal program:** terminal mode, written once in phase 2 for Codex's fallback, covers
  it. The task runs in a herdr-core terminal, its state comes from Herdr's status (Herdr already reports Claude Code
  and Codex this way; another agent needs Herdr to recognise it), its last message from its own files or the screen, and send is
  `hc send` when idle. About 1 day. No rename, no queue.
- **A chat** on such an agent needs a way in besides typing. Without one, notices fall back to being typed in
  when the chat is idle (the path Claude Code chats already keep as their fallback), and there are no cards.

## 10. What a real model changed

Run on 2026-11-22 with `dev/sandbox up --app --codex real`: a sandbox `HOME` and `CODEX_HOME` holding a copy of
a ChatGPT Plus login (deleted afterwards; the user's own `~/.codex` was never used), the sandbox's own Codex
daemon, and herdr-channels from the working tree in a sandboxed Herdr. Model `gpt-6.2-sol` at Codex's default
settings, in small throwaway repos. 35 sessions in all.

| Question | Result | Evidence |
| --- | --- | --- |
| Instructions files | `AGENTS.md`, `CLAUDE.md` (with the fallback) and developer instructions all reach the task | Each asked for a marker line: "Hello, BRIEF-OK! AGENTS-OK" from `AGENTS.md` + instructions; "Hello! CLAUDE-OK" with the fallback; plain "Hello!" without it; only "AGENTS-OK" with both files |
| Does a real turn say it's asking? | No structured signal in the default mode. The turn ends `idle` like any finish | 14 prompts in one repo (vague ones like "Rename the project", "Delete the old files", "Set up deployment"; clear ones like "Fix the bug in util.js"). 5 asked; 9 finished |
| "Ends with ? or options", alone | 1 of 5 questions caught, 0 false positives | Four questions had a sentence after them: "Which files should I delete? Please give me the paths, or …"; "What command name …? I suggest `util`. I'll wait for your choice before writing it." None listed options |
| With the question rule in the developer instructions | 9 of 9 right (6 questions, 3 finishes), 0 false positives | Every question became its own last line: "…I haven't changed any files.\n\nWhich app, site, or file should I update?" Finishes ended without one, including "Should greet() take a title too? Do what you think is best" |
| With `outputSchema` | 4 of 4 right, options given | `{"status":"needs_user", …, "question":"Should I set up publishing this as an npm package, or …","options":["Publish as an npm package","Deploy an app or service"]}`. The terminal shows that JSON as the reply |
| A real approval | Only to leave the sandbox | `curl -sI https://example.com` ("Allow curl to reach example.com …?") and `mv -n qa acme-tools` ("May I rename the workspace folder …? The sandbox blocked moving the folder."). None of the other 32 tasks asked |
| The approval in the service | `active[waitingOnApproval]`, and the request replays to a late client | A client connecting a minute later got `item/commandExecution/requestApproval` with `reason`, `command`, `cwd` and `availableDecisions` (`accept`, accept with an exec-policy amendment, `decline`, …) |
| The approval in Herdr | `blocked`, `permission` | `codex resume <id>` in a herdr-core terminal showed "Would you like to run the following command? … 1. Yes, proceed (y)"; `hc get` gave `{app: codex, state: blocked, kind: permission}` |
| Answered remotely | Works, both ways | `accept`: the command ran, "`HTTP/2 200`", the terminal's prompt cleared, Herdr went `done`. `decline`: the turn went on and said "The workspace folder is still named `qa` because the request to move it was declined." |
| Folder trust | Never for a task | A daemon task in an untrusted folder ran with no dialog; `codex resume` there showed none. A fresh `codex` there showed "Trust this folder? …", and Herdr gave `status: null` |
| Hook trust | Once per machine per hook command | "Hooks need review · 1 hook is new or changed", Herdr `status: null`. After "Trust all": a second chat and a resumed chat didn't ask; a changed command did. `hooks/list` gives `trustStatus` |
| Ride-along | Hook and `thread/inject_items` both reach a real model | The hook's context: "Hi! RIDEALONG-OK". An injected developer message on an unloaded task, then "Any news?": "The logo task is complete. INJECT-OK." |
| A multi-turn task, resumed later | Works | A task idle and `notLoaded` for about 15 minutes took "Call it acme-tools…", asked one approval (declined from outside), finished; a message queued mid-turn ran next as turn 3 |
| Notices into a Codex chat | Works with real turns | Idle: `turn/start` showed `› [task notice] …` and a one-line reply. Busy (a `sleep 15` turn): `thread/queue/add` (it now needs a `clientUserMessageId`) ran right after it |
| A daemon stop mid-turn | Graceful | `codex app-server daemon stop` during a `sleep 40` turn waited ~39 s; the task's turn was complete, and a later message ran normally |
| Thread names | As set | `thread/name/set` names showed in `thread/list` and the TUI's footer. A chat with no name was named after its first prompt ("Say hi") |

**Cost and rate limits.** A ChatGPT plan has no per-token bill: Codex use counts against the plan's windows,
which `account/rateLimits/read` gives as percentages (a 5-hour window and a weekly one) with the plan type. All
35 sessions used 2.57M input tokens (83% from cache) and 9k output tokens, which was 9% of a Plus plan's 5-hour
window and 1% of its week. A typical small task used 19k–160k tokens, mostly cached: a question asked without
looking (19k), a one-file fix (95k), setting up a test runner (161k). That is roughly a quarter of a percent of
the 5-hour window each, so a Plus plan carries dozens of small tasks per window. With an API key instead, the
same tokens are billed per token, and the account type is visible to the harness (`account/read`'s
`authMode` and `planType`).

**What carries over to phases 2–4.** `dev/sandbox` holds the recipe: `task`, `follow --approve`, `send`, `chat`,
`last` and `usage` are the calls phase 2's `bin/harness/codex.mjs` makes, and `dev/codex-rpc.mjs` is the client
to grow into `bin/codex-rpc.mjs`. Protocol details the real run found: `thread/queue/add` needs a
`clientUserMessageId`; `thread/resume` subscribes a client and loads an unloaded thread; reading a whole thread
is deprecated in favour of `thread/turns/list` and `thread/items/list` (`excludeTurns: true`), which `scan`
should use; and `turn/start` takes `additionalContext` and `outputSchema`.

