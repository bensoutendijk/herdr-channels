# Harnesses: Codex beside Claude Code

herdr-channels runs every task and every chat on Claude Code today. This is the design for a harness layer that
lets a task, or a channel's chat, run on another coding agent too, starting with OpenAI's Codex CLI. It is a
design, not the feature: nothing here is built yet.

It was checked on 2026-11-22 against Codex CLI 0.171.0 (the current release) and Claude Code 2.1.330, on macOS.
Codex ran in a sandbox `HOME` of its own. No Codex sign-in existed on this machine, so its turns ran against a
small local stand-in for the OpenAI Responses API that answers with scripted turns (Codex's `model_providers`
setting points it there). That covers everything around the model: sessions, the daemon, approvals, hooks,
Herdr's view of the terminal. What a real model does with it (how often it asks for approval, how it names
threads) still needs one signed-in run (see [Risks](#8-risks-and-open-questions)).

**Short answer: go.**
- Codex tasks fit the task model well: Codex 0.171 keeps sessions in a local daemon of its own, much as
  `claude --bg` does. Its protocol starts a task with no terminal, reports each task's state (including "waiting
  on an approval"), sends it messages, renames it, and lets a terminal open it live mid-turn. All of that was
  tested.
- A Codex chat is viable too: a notice can start a turn in an idle chat without typing into its terminal, a
  `UserPromptSubmit` hook carries ride-along news, and routines can queue into it. What's lost: notices show as
  a user message rather than Claude Code's faded one-line event, and there are no task cards.
- Recommended order: the harness seam first, with Claude Code only and no change in behaviour. Then Codex
  **tasks**, driven from the existing Claude Code chat. Then a Codex **chat**. Then the hub's parity.

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

## 1. What was tested

| Question | Result | How |
| --- | --- | --- |
| Codex in a herdr-core terminal | **Works** | `hc run --bg -- codex -a never -s workspace-write "<brief>"`. Herdr tags the terminal `agent: "codex"` |
| Herdr's view of a Codex terminal | **Reliable** for working, done and blocked | `hc get --json` gave `status {app: codex, state: working}`, then `done` when the turn ended (and `turn` went up), and `{state: blocked, kind: permission}` at an approval prompt. Codex's folder-trust dialog showed as `status: null`, not blocked |
| A thread outlives its terminal | **Yes** | The TUI is a client of a shared daemon (`codex app-server --listen unix:// --managed-daemon`) that Codex starts by itself. After `hc kill` on the terminal, the daemon kept the thread |
| Start a task with no terminal | **Works** | Over the daemon's control socket: `thread/start` (folder, sandbox, approval policy, developer instructions), `thread/name/set`, `turn/start`. The client disconnected at once; the turn finished, and the session file recorded the last message |
| A task's state | **Works** | `thread/list` and `thread/read` give `status`: `idle`, `active` (with flags `waitingOnApproval` or `waitingOnUserInput`), `notLoaded` or `systemError`, plus its name, folder and session file |
| A message to a task later | **Works** | `turn/start` on an idle thread; `codex queue --thread <id> --message <text> --resume` from the command line, also on a thread no client had loaded |
| Answer an approval | **Works** in the task's terminal | `hc keys <t> y` on Codex's "Would you like to run the following command?" |
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
2. `thread/start` with the folder, and the sandbox and approval policy from `--permission-mode`:

   | `--permission-mode` | Codex |
   | --- | --- |
   | (none), `default` | `workspace-write` sandbox, approvals `on-request` (Codex's own default) |
   | `auto` | `workspace-write`, approvals routed to Codex's automatic reviewer (`approvalsReviewer`, as `--approve-for-me`) |
   | `plan` | `read-only`, `on-request` |
   | `bypassPermissions` | `danger-full-access`, `never` |

   The thread keeps these settings, so `send` passes none: unlike `codex exec resume`, which takes the settings
   of the command that resumes it, a turn started over the daemon keeps the thread's settings.
3. `thread/name/set` with the task's name (Codex otherwise names a thread after its first prompt).
4. `turn/start` with the brief. The brief is all the task gets, as now.

It is filed as `<machine>/<thread id>` with `harness: "codex"`. Codex thread ids are UUIDs like Claude Code's
session ids, so the store keeps the harness on the task rather than guessing it from the id.

**Tracked**: the listener asks the Codex harness for a `Snap` of each open Codex task: one `thread/list` call for
every thread, then the session file's tail for the threads that changed.

| Codex | channels state | Event |
| --- | --- | --- |
| `active`, no flags | working | none |
| `active`, `waitingOnApproval` | waiting_on_user, a prompt | needs: a "prompt" card, answered in the task's view |
| `active`, `waitingOnUserInput` | waiting_on_user, a question | needs: a question card (Codex's `request_user_input`; only in its Plan mode today) |
| `idle`, last turn ends asking something | blocked | needs: a question card with its options (see below) |
| `idle`, last turn complete | done | done: a notice |
| `idle`, last turn failed or aborted (`task_complete.error`, `turn_aborted`) | failed | done |
| `notLoaded`, last turn started but never completed | paused | none (the daemon stopped mid-turn) |
| `systemError` | failed | done |

Claude Code says itself when a job ended its turn asking something (its `blocked` state). Codex has no such
signal in its default mode: the turn just ends. So for Codex, a finished turn whose last message ends with a
question counts as one: a short list of options (`optionsOf`, as the cards already parse), or a last line
ending in "?". Anything else is a finish. This is a heuristic, and it is an open question below.

**Answered**: an answer from a card, or from the chat with `channels send`, goes through `send`. A question
(the turn is over) takes `turn/start`, and the task continues. An approval prompt is refused with "answer it in
its view in the panel", as for Claude Code. Later, the listener could answer approvals itself (the protocol has
`item/commandExecution/requestApproval` with accept, accept for the session, or decline), which would give the
cards Allow and Deny buttons, something Claude Code tasks don't have. That is phase 5.

**Sent to while working**: Codex queues safely (`thread/queue/add` runs once the turn ends, tested), so a message
to a working Codex task is queued and the reply says so, instead of being refused as it is for Claude Code.
There are never copies: `delivered_as` is `resumed` or `queued`, and the copy-filing path stays Claude Code's.

**Resumed**: nothing extra to do, since the daemon holds the thread. A thread the daemon unloaded (it unloads
idle threads a minute after their last client leaves) is loaded again by `thread/resume` before the turn.

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

The chat gets its own app-server so its settings (the chat's prompt, its hook) reach only it, as `--settings`
and `--append-system-prompt` do for a Claude Code chat. (Per Codex's source, a TUI started with its own `-c` settings
doesn't use the shared daemon but runs a server of its own, so the chat's server is made explicit.) The thread itself is an ordinary Codex session in
`~/.codex`, so the chat resumes on it after a restart, and the user can open it in Codex's own tools.

### How things reach it

| What | Claude Code chat today | Codex chat |
| --- | --- | --- |
| A task finished (notice) | Pushed through the notices channel: one faded `← tasks: …` line, then a short turn once idle | `turn/start` with a one-line `[task notice] …` when the chat is idle; `thread/queue/add` while a turn runs, which runs after it. The RPC's answer confirms delivery, so there is no transcript matching and no typed fallback |
| Ride-along news | The `UserPromptSubmit` hook (`pending --hook`) | The same hook and command, in Codex's hook format (its output is the same JSON shape). Fallback: `thread/inject_items` as each event arrives |
| A wake (a registered question) | Typed into the terminal with `hc send` | `turn/start` or `thread/queue/add`, as a notice |
| A routine | Typed in with `hc send` | `thread/queue/add`: it waits for any turn in progress and never lands in a half-typed draft |
| Idle? (refresh, notices) | `~/.claude/sessions` status and the terminal's status | The thread's status from the chat's server, and the terminal's status |
| A draft on screen? | The `❯` line | The `›` line: empty when it shows Codex's placeholder ("Ask Codex to do anything") |
| Restart on a new build | SIGTERM to `claude`, the loop runs it again | Stop the TUI and the chat's server, and the loop runs both again on the same thread |
| The chat's prompt | `--append-system-prompt` | `developer_instructions`. The words change from "one long-lived Claude Code session" to the harness's name; the rest is the same |

Codex asks the user to trust a hook before it runs it (once; it records the trust by the hook's hash in the
user's `config.toml`). The hook's command is kept the same for every chat (the channel comes from the
environment of the chat's server), so that is asked once per machine. The listener can answer it at start, as
it answers Claude Code's development-channel prompt today. Until it is trusted, ride-along news goes in by
`thread/inject_items` instead.

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
| Ride-along | n/a | Same hook, after one trust | |
| Routines | n/a | Same; queued rather than typed | |
| Refresh | Nothing to do (the daemon holds tasks) | Same rule, harness answers idle and draft | The row names each harness's version |
| Remote Control (#22) | **Hidden** | **Hidden** | Codex's remote control pairs the daemon with the Codex app, not a link per session. A later `caps.remoteControl: 'pairing'` could offer "Pair with the Codex app" |
| Cloud tasks (#23) | **Hidden** | n/a | Codex Cloud has `codex cloud exec --env <id>`, `list --json`, `status`, `apply`: a later cloud placement for Codex, with its own environments |
| Approvals from a card | Phase 5 | n/a | Only possible with Codex |
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
   "may interrupt running work". A task cut off that way shows as paused (§3), and a message resumes it.
3. **Only tested against a stand-in model.** No Codex account was used. One signed-in run is needed before Codex
   tasks ship, to see real approvals, names and timings.
4. **Questions are guessed** for Codex tasks (§3). A wrong guess shows a finish as a question card, or the
   reverse; both are visible and cheap to correct.
5. **Folder and hook trust live in the user's Codex config.** Codex asks once to trust a folder (the projects
   folder) and once to trust the chat's hook, and writes both into `~/.codex/config.toml`. That is Codex's own
   consent flow, like the trust prompt Claude Code shows. channels never writes that file itself; the
   installer tells the user to run `codex` once in the projects folder, as it does for Claude Code.
6. **Instructions files.** Codex reads `AGENTS.md`, not `CLAUDE.md`. A task in a repo that has only `CLAUDE.md`
   starts without its rules unless channels passes `project_doc_fallback_filenames = ["CLAUDE.md"]` for Codex
   tasks.
7. **Notices look heavier** in a Codex chat (§4), against the Duet-style one-line notice the product aims for.

### Open questions

1. **Order.** Codex tasks first, driven from the Claude Code chat, and the Codex chat after? *Recommended:
   yes.* Tasks carry most of the value, risk the least, and keep cards.
2. **Where Codex tasks run.** In the user's shared Codex daemon (headless, like `claude --bg`), or each in a
   herdr-core terminal? *Recommended: the daemon*, with terminal mode as the fallback when its protocol doesn't
   answer.
3. **Defaults.** Claude Code for chats and tasks unless a channel says otherwise, with a per-channel default for
   tasks? *Recommended: yes.*
4. **A Codex chat at all.** Worth phase 3, given notices that look like user messages and no cards? *Recommended:
   yes, but after Codex tasks have been used for a while*: if they're enough, the chat can wait.
5. **Questions by heuristic.** Treat a Codex turn that ends with options or a "?" as a question? *Recommended:
   yes.* The alternative is that every Codex stop is a finish, and its questions arrive only as notices.
6. **Answering Codex's hook trust prompt** from the listener, as it answers Claude Code's development-channel
   prompt today? *Recommended: yes*, said in the README.
7. **`CLAUDE.md` for Codex tasks.** Pass `CLAUDE.md` as a fallback instructions file? *Recommended: yes*, for
   tasks channels starts (it never changes the user's config).
8. **The default sandbox** for Codex tasks: `workspace-write` with approvals on request (Codex's own default)?
   *Recommended: yes*, with `--permission-mode` mapped as in §3.
9. **The hub.** Its parity after Codex tasks work here, rather than in step with them? *Recommended: after.*
10. **A real run.** Sign Codex in inside a sandbox for one supervised run before phase 2 merges, with a
    ChatGPT account or an API key? *Recommended: yes.* Someone has to choose the account.

## 9. Phases

| Phase | Size | Delivers |
| --- | --- | --- |
| 1. The seam | S (1–2 days) | `bin/harness/claude.mjs` with everything Claude Code-specific from `bin/channels.mjs`, behind the interface; the listener and `list` go through it; cloud becomes the Claude harness's placement. No behaviour change: the existing tests pass unchanged, plus tests for the interface |
| 2. Codex tasks | M–L (3–5 days) | `bin/harness/codex.mjs`, `bin/codex-rpc.mjs`; `channels start --harness codex`, read, send (queued while working), rename, file, dismiss; events and cards in the Claude Code chat; the panel's standing, harness mark and New session menu; `install.mjs --codex`; `harnesses` in `capabilities` and `list`; terminal mode as the fallback; a README section, and screenshots per the repo's rule |
| 3. A Codex chat | M (2–3 days) | The per-chat app-server; notices by `turn/start` and the queue; the hook, trusted once; routines queued; refresh for a Codex chat; the chat's prompt worded per harness; `channels harness <channel> --chat`, and the channel menu's choice |
| 4. The hub | M (2–3 days, its own repo) | §7's list, in the server's command; `capabilities` says `harnesses` once it's done |
| 5. Later, as wanted | S each | Approvals answered from a card (Codex only); Codex Cloud as a cloud placement; "Pair with the Codex app"; Codex's `request_user_input` answered from a card |

Tasks come before the chat because they need no chat changes at all: the Claude Code chat starts, reads,
answers and hears about Codex tasks through the same `channels` commands, and its cards work for them. That
gives a usable multi-harness product after phase 2. The chat is where the harnesses differ most, so it waits
for what phase 2 teaches.

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
