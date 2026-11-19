# Remote Control for channel sessions: research

Can every Claude Code session that herdr-channels runs (each channel's chat and every task) have Remote Control
on, so that it shows up and can be answered at claude.ai/code and in the Claude phone app? This is the other
direction from [cloud-tasks-research.md](cloud-tasks-research.md): the tasks stay local, and the phone gets to
reach them.

Checked on 2026-11-19 with Claude Code 2.1.329 on macOS, signed in to a claude.ai subscription. All tests ran in a
sandbox (its own `HOME` with the login keychain linked in, its own herdr-core, `CHANNELS_MACHINE=studio`), as the
README's "Trying a change in a sandbox" describes, and every session was stopped afterwards. The user's own Herdr,
Claude settings and other machines weren't touched. Session ids are shortened (`session_01…XXXX`). What a session
shows in the account's session list was read with Claude Code's own peer listing (`ListAgents`) in a session that
has Remote Control on. That listing is the same account list that claude.ai/code and the app show.

**Short answer: works.** One flag per launch turns it on for tasks and the chat. `channels send` keeps it without
any change. Each session gets a stable claude.ai URL that `channels` can read from files it already reads.
Recommendation: **go**, scoped to herdr-channels sessions through flags that `channels` passes, opt-in per
machine, with the claude.ai link shown on tasks. About a day of work (sketch at the end). On the work laptop, leave
it off until that machine's sign-in and its org's policy are checked (§5).

| Question | Verdict | How |
| --- | --- | --- |
| 1a. Task (`claude --bg`) | **Works** | `claude --bg --remote-control [name] …`, or `--settings '{"remoteControlAtStartup":true}'` |
| 1b. `channels send` (`claude --bg --resume`) | **Works** with no change | Claude Code resumes a background session "with its saved options", `--remote-control` among them. Same claude.ai session |
| 1c. `claude attach` (the panel's task view) | **Works** | Attach is only a view: the worker keeps its connection |
| 1d. Copies Claude Code starts | **Partial** | A copy gets only the flags passed to the command that made it. `send` passes none, so a copy loses Remote Control unless the user setting is on |
| 1e. Channel chat (`--session-id`/`--resume` in herdr-core) | **Works** | `remoteControlAtStartup: true` in the `--settings` the chat already gets, or `--remote-control <name>`. Same claude.ai session after a restart |
| 1f. User setting `remoteControlAtStartup: true` | **Works** | Covers all of the above, copies too, and also every other session on the machine |
| 2. Scope | Recommend **flags from `channels`** | See §2 |
| 3. What you see | **Works**, with naming and stale-state caveats | Task name or `#channel`; states `running`/`idle`/`requires_action`/`offline` |
| 4. Integration | **Partial** | A stable URL per session: **yes**. Listing and events for scripts: **no**, only inside a session and as phone pushes |
| 5. Limits and risks | See §5 | Plan and org policy, which account the work laptop is signed in to, transcripts on Anthropic's servers, a few connections per session |

## 1. Turning it on

### Tasks: `claude --bg`

With no setting and no flag, a background session has no Remote Control. The probe asked each session to run
`echo "bridge=$CLAUDE_CODE_BRIDGE_SESSION_ID"`, which is set only while a Remote Control connection exists:

```
$ claude --bg -n "rcprobe 1 bg plain" --model haiku --permission-mode auto 'Run … echo "bridge=$CLAUDE_CODE_BRIDGE_SESSION_ID child=$CLAUDE_CODE_CHILD_SESSION"'
backgrounded · 552d32b5 · rcprobe 1 bg plain
→ bridge= child=1

$ claude --bg --remote-control "rcprobe 2 rcflag" -n "rcprobe 2 rcflag" … 'Run … echo "bridge=$CLAUDE_CODE_BRIDGE_SESSION_ID"'
backgrounded · a6bae449 · rcprobe 2 rcflag
→ bridge=session_01…6yp8

$ claude --bg --settings '{"remoteControlAtStartup":true}' -n "rcprobe 3 settingsflag" …
backgrounded · a82d8411 · rcprobe 3 settingsflag
→ bridge=session_01…gKCA
```

So both the flag and `remoteControlAtStartup` given through `--settings` work. (The docs say project and local
settings can only turn it *off*. Flag settings can turn it on.) The job's record,
`~/.claude/jobs/<job>/state.json`, then holds:

```json
"respawnFlags": ["--remote-control", "-n", "rcprobe 2 rcflag", "--permission-mode", "auto", "--model", "haiku"],
"bridgeSessionId": "cse_01…6yp8",
"bridgeOutboundOnly": false,
"bridgeOwnerAccountUuid": "…", "bridgeOwnerOrganizationUuid": "…"
```

`--remote-control-session-name-prefix` (and `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX`) only change
*auto-generated* names (`<hostname>-<adjective>-<animal>`). `channels` always names its sessions, so it doesn't
need it.

### `channels send`: `claude --bg --resume`

`send` stops a finished task, waits for its process to exit, and runs `claude --bg --resume <session> <message>`
with no other flags. That keeps Remote Control:

```
$ claude stop a6bae449
$ claude --bg --resume a6bae449-… 'Run again … echo "bridge3=$CLAUDE_CODE_BRIDGE_SESSION_ID"'
note: woke session a6bae449 with its saved options (--remote-control, -n, --permission-mode, --model).
→ bridge3=session_01…6yp8            # the same claude.ai session as before
```

The `--settings` variant resumes the same way (`woke session a82d8411 with its saved options (--settings, …)`,
same `session_01…gKCA`).

**Passing flags to a resume makes a copy.** So `send` must keep passing none:

```
$ claude --bg --resume 4062e671-… --remote-control '…'
note: background session 4062e671 keeps its own saved options, so the flags you passed started a copy as 4352780d. Without flags, the same command continues 4062e671 itself.
```

### Copies

Claude Code starts a copy when `--bg --resume` meets a session whose process still runs. (`send` waits for the
exit to avoid this, and files the copy if it happens anyway.) In the test, `claude stop` returned before the
process had exited, so the resume made a copy:

```
$ claude stop a6bae449 ; claude --bg --resume a6bae449-… '… echo "bridge2=…"'
note: session a6bae449 is already running in the background, so this started a copy as 4062e671. `claude attach a6bae449` opens the original.
→ bridge2=                            # the copy has no Remote Control; its respawnFlags are []
```

A copy started *with* flags (above) does get Remote Control, as a new claude.ai session (`session_01…Mx5j`). Its
claude.ai title then comes from its first message, since no `-n` was passed. With the user setting on, every copy
gets Remote Control.

### `claude attach`

The panel opens a task through `claude attach` (behind viewer.py). Attaching to a task with Remote Control on, in a
herdr-core terminal, shows the connection in the transcript header:

```
❯ Use the AskUserQuestion tool to ask me: "Which color for the probe?" …
  /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01…ytoA
```

Answering the question in the attached view worked, and the session stayed connected. Attach doesn't start a
process of its own, so it neither adds nor removes Remote Control.

### The channel chat

`channels chat <name>` runs `claude --session-id|--resume <id> -n '#<name>' --settings '<chatSettings>' …` in a
herdr-core terminal. For the test, `chatSettings()` got one extra key, `remoteControlAtStartup: true`. The patch
was reverted afterwards. The chat was then started the real way (`channels chat rcdemo --bg --json`):

```
→ bridge=session_01…iALCW child=1 entry=cli term=t1
```

After `hc kill t1` and `channels chat rcdemo --bg` (the chat resumes its session), it was **the same**
`session_01…iALCW`. The listing showed it as `#rcdemo · Remote Control · idle`. The task cards hook and
`HC_TERMINAL_ID` were unaffected. `child=1` is the usual value inside a Bash tool call, not a quirk of herdr-core.

### The user setting

With `{"remoteControlAtStartup": true}` in the sandbox's `~/.claude/settings.json`, a plain `claude --bg` got Remote
Control (`bridge7=session_01…h8XB`). So did resuming an old task that never had it, with no flags
(`woke session 552d32b5 with its saved options (-n, --permission-mode, --model)` → `bridge8=session_01…hDcB`, a new
claude.ai session).

Side effect seen: after the first Remote Control sessions ran, Claude Code wrote `"agentPushNotifEnabled": true`
into the sandbox's user settings by itself.

### Env under herdr-core

- `cleanEnv()` already removes `CLAUDE_CODE_BRIDGE_SESSION_ID` (with `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and
  the rest) before it starts a task or the chat. So a task started from a Remote Control chat doesn't inherit the
  chat's connection. It gets Remote Control only if `channels` asks for it.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` in the environment turn Remote
  Control off (docs). Neither is set by herdr-core or `channels`.
- No trust prompt in the way: `channels` runs in the projects folder, which is already trusted.

## 2. Scope: flags from `channels`, or the user setting

| | Flags passed by `channels` | `remoteControlAtStartup` in user settings |
| --- | --- | --- |
| Covers | The chat, tasks started by `channels start` and the panel's New session | Every interactive and background session on the machine |
| Copies | Lost (rare; `send` waits for the exit) | Kept |
| Old tasks | Only new ones. An old task resumed with flags would become a copy | Old tasks get it on their next resume |
| Names on claude.ai | `channels` picks them (e.g. adds the machine to `#channel`) | Whatever `-n` says |
| Per machine | Yes: an install option | Yes, but it's the user's own file, outside this repo |
| Code | ~1 day | None. It can be done today with `/config` → "Enable Remote Control for all sessions" |

**Recommendation: flags from `channels`, opt-in per machine.** The goal is that the *channel* sessions are
reachable from the phone. Turning it on for everything also puts every ad-hoc terminal session in the claude.ai
list, and on the work laptop that's the part to keep under control. The flag lives in this repo, so it is tested
and works the same on every machine that installs channels. The user setting stays available, and if it's on,
the flags are harmless (same result). Its one real advantage is copies, which are rare and already reported to
the chat when they happen.

Use `--remote-control <name>` rather than the settings key for tasks. It also sets the claude.ai title without
changing the local name. In the test, `--remote-control "#rcdemo · studio" -n "rcprobe 11 localname"` showed as
`#rcdemo · studio` on claude.ai, and as `rcprobe 11 localname` in `claude agents`.

## 3. What you see

- **Names**: a task shows under its `-n` name (`rcprobe 2 rcflag`). The chat shows as `#rcdemo`. The account list
  doesn't say which machine a session runs on, and the same channel can exist on several machines (the home
  server's chats already show there as `#<channel>`). So the chat's claude.ai name should carry the machine:
  `#general · <machine>`. Tasks can keep their own names.
- **States**, as the list shows them: `running`, `idle`, `requires_action` (a question or permission prompt
  waiting), `offline`.
- **Answering from the phone while the panel shows the same session**: one session, two views. Answering in the
  attached panel view cleared the question for both (tested). Answering from claude.ai or the app is the
  documented core of Remote Control, and the user already uses it, but it wasn't driven by hand in this test.
  Worth one manual check after the change: start a task that asks a question, answer it on the phone, and watch the
  panel's card clear.
- **A message is not an answer**: a cross-session message (`SendMessage`) to a session waiting on a question was
  delivered. It showed in the task as `› Message from @…: Answer to your probe question: Blue.` But it stayed
  queued and the question stayed open (`waitingFor: "input needed"`) until the dialog was answered. That's the same
  as for cloud sessions.
- **Session ends**: `claude stop` and `/exit` took the session out of the list within seconds, with nothing left to
  archive. A **hard kill** (`kill -9`, a crash, or most likely a Mac that sleeps or loses its network) left the
  session listed as `idle` for at least 8 minutes. Resuming it and stopping it properly then cleared it.
- **Sleep**: not tested; this Mac wasn't put to sleep. The docs say an interactive session "reconnects
  automatically when your machine comes back online". Expect the list to show stale `idle` or `offline` while the
  Mac sleeps, and messages from the phone to wait until it wakes. "Keep going with the lid shut" isn't what Remote
  Control does. That's what cloud sessions or the home server are for.
- **Push**: the docs give two `/config` toggles, "Push when Claude decides" and "Push when actions required"
  (questions and permission prompts), and say pushes are skipped while you are at the connected terminal. The phone
  app must be signed in to the same account and organization.

## 4. Integration value

- **A stable URL per session: yes.** `https://claude.ai/code/session_<id>`, where `<id>` is the part after `cse_`
  or `session_` in:
  - `~/.claude/sessions/<pid>.json` → `"bridgeSessionId": "session_01…"` while the process runs. `channels` already
    reads these files for state.
  - `~/.claude/jobs/<job>/state.json` → `"bridgeSessionId": "cse_01…"`. It stays after the process exits, which
    suits tasks.
  - the transcript → `{"type":"bridge-session","bridgeSessionId":"cse_01…",…}` lines. This also works for the chat
    once it has exited.

  It stayed the same across `send` (background resume) and across a chat restart (interactive `--resume`). It
  changes only for a copy, or when a session gets Remote Control for the first time on a later resume.
- **"Open" on claude.ai: yes.** A task card and the task view can offer "Open on claude.ai" (`open <url>`) or "Copy
  link" next to the existing Open, which shows the task in the panel. The panel's Open stays the default. The
  link is for handing a session to the phone.
- **Listing for scripts: no.** No CLI or documented API lists Remote Control sessions. `claude agents --json` still
  lists only this machine's sessions, with the same fields as before. The account-wide list with states exists
  only inside a Remote Control session, as Claude Code's peer listing. A channel chat with Remote Control on could
  look at it and see a task's state on another machine (`requires_action` there), but `channels` itself can't.
- **Events: no new ones for `channels`.** Finish and question events still come from the local session records,
  as now. The new event path is to the *person*: phone pushes on questions and permission prompts, which already
  covers what the task cards do when you're away from the Mac.
- **Cross-machine messages**: a session with Remote Control on can `SendMessage` a Remote Control session on
  another machine by its listed name (tested: delivered). That's a possible later route for a chat on one machine
  to message a task on another. It doesn't answer dialogs, and it reports nothing back.

Compared with the cloud research, Remote Control fills the gap for local tasks. The phone can see state, answer
questions and send turns, and every session has a stable link. What neither one gives is a scriptable list or
event feed across machines.

## 5. Limits and risks

- **Plan**: Pro, Max, Ultra, Team and Enterprise, signed in with claude.ai (`claude auth login`). Not with an API
  key, Bedrock, Vertex or Foundry, an `ANTHROPIC_BASE_URL` gateway, ZDR or HIPAA. Without an eligible login,
  `claude --remote-control` starts **with Remote Control off** (docs). The task still runs, so the flag is safe
  to pass everywhere.
- **Org policy**: on Team and Enterprise, an Owner must turn on Remote Control under admin settings → Claude Code.
  Custom roles need the "Claude Code remote control" permission. A `disableRemoteControl` managed setting turns it
  off. The error is `Remote Control is disabled by your organization's policy`. A company laptop's MDM can push
  that setting.
- **Which account the work laptop uses**: sessions go to whatever account and organization Claude Code on that
  machine is signed in to (the job record keeps `bridgeOwnerOrganizationUuid`). On the work laptop that's normally
  the company org. Its sessions then show in the company org's claude.ai list, which the phone app has to be
  switched to. They would not show next to the personal ones. If the work laptop is signed in to the personal
  account instead, work code transcripts land in the personal account. A company policy would likely forbid that.
- **Privacy**: while connected, the transcript (messages, replies, tool activity, so code and command output) is
  stored on Anthropic's servers under the account's data policy. Execution and files stay local, and the
  connection is outbound HTTPS only, with no open ports (docs). Session titles are visible to anyone who can see
  the account's session list.
- **Cost**: per session, a few more connections and some memory, no measurable idle CPU. Established TCP sockets:
  24 for a plain background session, 27–31 with Remote Control. Memory: 320 MB for the plain session, 340–480 MB
  with Remote Control, but tasks in different states vary that much on their own. With Remote Control on, each
  interactive process holds one session (docs). No limit was hit with eight at once. The list grows by one row per
  task. Dismissed tasks that are stopped leave it.
- **Stale rows**: a task whose process dies without a clean stop stays listed (as `idle`) until it is resumed and
  stopped, or archived by hand in claude.ai.
- **Checking a machine** (the work laptop, before turning it on there):

  ```sh
  claude auth status                        # which account and org this machine uses
  claude --bg --remote-control -n "rc check" "Reply with only ok."
  grep bridgeSessionId ~/.claude/jobs/<job>/state.json   # present: allowed; absent: run /remote-control in a claude to see why
  claude stop <job>
  ```

## Recommendation and sketch

**Go**, as an opt-in per machine: on for the personal Mac, off on the work laptop until the check above passes and
the session list it lands in is the intended one.

### Change to `channels`

1. **Setting**: `CHANNELS_REMOTE_CONTROL=1` in the `channels` wrapper, written by `install.mjs --remote-control`
   (and removed by installing again without it). Off by default.
2. **Tasks**: `start()` in `bin/channels.mjs` adds `--remote-control <label>` to the `claude --bg` arguments when
   it's on. `send()` stays as is: saved options carry it, and flags would make a copy.
3. **Chat**: `chat()` adds `--remote-control '#<name> · <machine>'` (with `LOCAL`), keeping `-n '#<name>'`
   locally.
4. **Mod**: the panel's New session (`claude --bg` in `mods/channels/main.js`) adds `--remote-control`. Opening an
   old task without a job (`claude --resume … --settings {"disableAgentView":true}`) adds
   `"remoteControlAtStartup": true` to that settings object.
5. **Link**: a `remoteUrl(task)` helper reads `bridgeSessionId` from the job's `state.json` (else the live
   `sessions/<pid>.json`, else the transcript's last `bridge-session` line) and builds the claude.ai URL.
   `channels list --json` gives it as `remote_url`. The task view's header and the cards' ··· menu offer "Open on
   claude.ai". `channels read` prints it on the first line.
6. **Copies**: when `send` files a copy, the copy has no Remote Control (unless the user setting is on). Say so in
   the note it already gives the chat. Don't try to fix it with flags.
7. **Tests**: argv for `start`, `chat` and the mod with the setting on and off, `send` unchanged, `remoteUrl` from
   each of the three sources, and the wrapper text.

**Size**: about 60–90 lines in `bin/channels.mjs` and `install.mjs`, 20–30 in the mod (the link and menu item),
plus tests. About a day. Steps 1–4 alone (on, no link) are half a day.

### Not recommended

- Turning on the user setting from `install.mjs`: it changes every session on the machine, and the user's settings
  file isn't this repo's to edit.
- `claude remote-control` server mode as the way to run tasks: it spawns its own sessions (`--spawn`, capacity 32)
  outside `claude --bg`, so the job records, `send`, attach and the cards wouldn't apply.

## Left in the claude.ai list

Every probe session was stopped cleanly, and the account's session list showed none of them afterwards. If any
still appear at claude.ai/code (archived or offline), they're safe to archive: `rcprobe 1`–`11` (various
suffixes), `#rcdemo`, `#rcdemo · studio`, `bridge session id check`, and one titled
`Reply with only the output of: echo "bridge5=…"`.

Sources: code.claude.com/docs/en/remote-control and …/settings (`remoteControlAtStartup`), `claude --help`, and
`claude remote-control --help` (2.1.329).
