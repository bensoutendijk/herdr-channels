# herdr-channels

Slack-style channels for the [herdr](https://herdr.dev) app, backed by Claude Code and running
entirely on your machine.

A channel groups the work on one topic. Each channel has an icon, a description, a long-lived
Claude Code chat, and a list of tasks. A task is a Claude Code background session (`claude --bg`)
that you can open live in the tasks panel next to the chat. The chat can start tasks, read them and
send them messages. When a task finishes or asks a question, the tasks panel shows it, and the chat
hears about it with your next message; it is interrupted only when it asked to be.

Everything is local: the channel store is a folder on disk, tasks run under your own `claude`, and
the herdr mod runs every command on the same machine. No server is involved.

## Contents

| Path | Purpose |
|---|---|
| `mods/channels/` | The herdr mod: sidebar, header bar, tasks panel and dialogs |
| `layouts/channels.json` | The herdr layout that arranges the mod |
| `bin/channels.mjs` | The `channels` command (a single Node script, no dependencies) |
| `install.mjs` | Installer for the command, mod and layout |
| `test/` | Tests for the command and the installer |

## Requirements

- macOS
- The [Herdr desktop app](https://herdr.dev/download) (Herdr.app, Apple silicon), opened at least
  once (this creates `~/.config/herdr-app` and installs `hc`, the herdr-core CLI). The separate
  `herdr` terminal app (TUI) can't load mods, so it isn't enough on its own.
- Node.js 20 or later (`brew install node`)
- [Claude Code](https://claude.com/claude-code), signed in
- `python3` and `git`, both included with the Xcode Command Line Tools

## Installation

1. Install Node.js:

   ```sh
   brew install node
   ```

2. Clone the repository. The installed command runs from the clone, so keep it in place:

   ```sh
   mkdir -p ~/projects && cd ~/projects
   git clone https://github.com/bensoutendijk/herdr-channels
   ```

3. Trust the projects folder in Claude Code. Background sessions only start in a trusted folder.
   Run `claude` there, accept the trust prompt, then type `/exit`:

   ```sh
   cd ~/projects && claude
   ```

4. Install the Herdr desktop app, then open it once so that its configuration folder and `hc`
   exist. It updates itself after this:

   ```sh
   curl -fsSL https://releases.herdr.dev/app/install.sh | sh
   ```

   Or download [Herdr.dmg](https://releases.herdr.dev/app/Herdr.dmg) and drag it to Applications.

5. Run the installer:

   ```sh
   node ~/projects/herdr-channels/install.mjs
   ```

6. If `~/.local/bin` is not on your `PATH`, add it so `channels` is available in a terminal. The mod
   and the chats find the command without this step.

   ```sh
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
   ```

7. Verify the installation:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/channels
   channels create general
   channels list
   ```

   herdr now shows the channels layout with `#general` in the sidebar. Select it to open its chat.
   Press `ctrl-shift-l` to switch between layouts.

### Installer options

The installer:

- writes the `channels` command to `~/.local/bin`,
- copies the mod and layout into `~/.config/herdr-app`, and
- selects the channels layout.

It never overwrites existing files. If a mod or layout named `channels` already exists and was not
installed by this repository, the copy is installed under the next free name (`channels-2`, and so
on). Running the installer again updates a previous installation in place.

| Option | Default | Description |
|---|---|---|
| `--projects <dir>` | `~/projects` | Folder where chats and tasks start |
| `--store <dir>` | `~/.local/state/herdr-channels` | Where channels are stored |
| `--by <name>` | `user` | Name recorded when a task is resolved from the panel |
| `--bin <dir>` | `~/.local/bin` | Where the `channels` command is written |
| `--app-home <dir>` | `$HERDR_APP_HOME` or `~/.config/herdr-app` | herdr configuration folder |
| `--no-switch` | | Install without selecting the layout |
| `--dry-run` | | Show what would be installed without writing anything |

### Updating

```sh
cd ~/projects/herdr-channels && git pull && node install.mjs
```

## Usage

- **Channels.** Create a channel with **New channel** at the bottom of the sidebar. Use a channel's
  `···` menu to rename it, edit its instructions (the description its chat reads at startup), change
  its icon or archive it. Drag channels to reorder them.
- **Chat.** Selecting a channel opens its chat in the main area. Ask the chat to start work and it
  creates a task with `channels start`, writing a brief that the task can follow on its own.
- **Tasks panel.** The button at the top right toggles the panel. It groups the channel's tasks into
  *Needs input*, *Working* and *Ready for review*. A dot marks a task with an event you haven't
  seen (it finished or asked something since you last opened it). Click a task to open it live. Press the left arrow
  on an empty prompt to return to the list. **+** starts a new session in the projects folder. The
  check mark resolves a task: it is hidden from the panel, and the session is not stopped or deleted.

### Task events

The chat's tab runs `channels chat <channel>`. This starts the chat's Claude Code session and a small
listener alongside it. Every 3 seconds the listener reads Claude Code's records of the channel's
tasks (`~/.claude/jobs` and `~/.claude/sessions`). A task finishing, or stopping to ask a question
or show a permission prompt, is an *event*. Each event is delivered at one of three levels:

| Level | When | What happens |
|---|---|---|
| **panel** | Every event | The task gets a dot in the tasks panel until you open it there. |
| **ride-along** | The default, for finishes and questions | Nothing happens in the chat. The event waits in the store and is attached to your next message in the chat as background context. The chat mentions it only if it's relevant or blocking, in one line. |
| **wake** | Only when a registration exists for that task | The listener pastes a `[task report]` (with the task's final message in full) or a `[task question]` into the chat's herdr terminal with `hc send`, which waits until you stop typing. This starts a turn, and the message says why it woke the chat. |

Ride-along uses a Claude Code `UserPromptSubmit` hook. `channels chat` passes it to the chat with
`--settings`, so it applies to that session only and your own settings files are not touched. The
hook runs `channels pending <channel> --hook`, which prints the waiting events as additional
context and marks them delivered. A task's newer event replaces its older one while it waits.

A registration asks for the chat to be woken by a task's next matching event:

```
channels watch <session> --wake-on finish|question|any [--why <text>]
channels start <channel> --wake-on finish|question|any <brief | ->
channels send <session> --wake-on finish|question|any <text | ->
```

`finish` matches a task finishing, `question` a question or permission prompt, and `any` either.
A registration is used up when it fires; `--wake-on none` cancels one. `--why` is shown in the
wake message (for example, the words the user used to ask to be told). The chat registers when it
is waiting on a task's answer in order to report back, or when you ask it to tell you about a task.
A message `send` delivers to a copy of the task carries the registration to the copy.

An event identical to the last one recorded for its task is dropped at every level: no dot, no
ride-along, no wake, and a registration keeps waiting. That covers a task that did more work but
ended with the same final message, the same question asked again, and a task stopped while it
waited on a question (as `send` does). The store records what each task was last seen as, so
events that happen while the chat is closed are delivered when it next opens, and none arrives twice.

Anything typed into the chat starts a turn, so a prompt that another tool types into it on a
schedule is a wake by nature, and the waiting events ride along with it too.

To see what the listener would do right now, run `channels listen <channel> --once` (it records what
it does). `channels pending <channel>` shows what waits for the chat's next message without taking
it, and `channels seen <session>` clears a task's dot.

## Command reference

```
channels [list [<channel>]] [--all] [--json]
channels create <name> [--icon <text>] [--description <text>]
channels archive <name>
channels move <channel> <position>
channels rename <channel> <new-name>
channels icon <channel> <text>
channels describe <name> [--set <text> | --set -]
channels chat <channel>
channels start <channel> [--repo <project>] [--name <name>] [--model <model>] [--permission-mode <mode>] [--wake-on <on>] <brief | ->
channels file <channel> <session> [--name <name>] [--folder <path>]
channels read <session> [--limit <n>] [--json]
channels send <session> [--wake-on <on>] <text | ->
channels watch <session> --wake-on finish|question|any|none [--why <text>]
channels seen <session>
channels dismiss <session> [--by <who>]
channels listen <channel> --once
channels pending <channel> [--hook]
```

`channels send` can only reach a background task that has finished its turn. It stops the idle
session, waits for its process to exit, and resumes the same session with the message. If the
process is still running after 30 seconds (`CHANNELS_STOP_WAIT_MS`), the command fails and starts
nothing. If Claude Code starts a copy of the session instead of continuing it, `send` says so, gives
the copy's session id, and files the copy into the original task's channel in its place; the original
task is marked as superseded by the copy and resolved. Sending to a task that is still working, or
is showing a permission prompt, fails; answer prompts in the task's view instead.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CHANNELS_DIR` | `~/.local/state/herdr-channels` | The channel store |
| `CHANNELS_PROJECTS` | `~/projects` | Folder where chats and tasks start |
| `CHANNELS_MACHINE` | host name | Machine name that tasks are recorded under |
| `CHANNELS_PERMISSION_MODE` | `auto` | Permission mode for `start`; empty uses Claude Code's default |
| `CHANNELS_CLAUDE` | `claude` | The Claude Code executable |
| `CHANNELS_HC` | `hc` | The herdr-core executable |
| `CHANNELS_STOP_WAIT_MS` | `30000` | How long `send` waits for a stopped task's process to exit |

The installed `~/.local/bin/channels` sets `CHANNELS_DIR` and `CHANNELS_PROJECTS` to the values
given to the installer.

The mod's settings are in `~/.config/herdr-app/mods/channels/config.js`, which the installer writes.
They are: the path to the command, extra `PATH` folders, the projects folder and the `--by` name.

## Development

```sh
node --test test/*.test.mjs
```

The tests use a temporary home folder with stand-ins for `claude` and `hc`, so they need neither.
CI runs them on Linux and macOS.

## Uninstalling

```sh
rm ~/.local/bin/channels
rm -r ~/.config/herdr-app/mods/channels ~/.config/herdr-app/layouts/channels.json
```

This leaves the channel store (`~/.local/state/herdr-channels`) and any Claude Code sessions in
place. Delete them separately if you no longer need them.

## License

MIT; see `LICENSE`. The bundled Lucide icons and Unicode emoji data are covered by their own
licenses; see `THIRD_PARTY_NOTICES.md`.
