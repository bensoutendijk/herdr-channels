# herdr-channels

Slack-style channels for the [herdr](https://herdr.dev) app, backed by Claude Code and running
entirely on your machine.

A channel groups the work on one topic. Each channel has an icon, a description, a long-lived
Claude Code chat, and a list of tasks. A task is a Claude Code background session (`claude --bg`)
that you can open live in the tasks panel next to the chat. The chat can start tasks, read them and
send them messages, and it is notified automatically when a task finishes or asks a question.

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
- [herdr](https://herdr.dev), opened at least once (this creates `~/.config/herdr-app` and installs
  `hc`, the herdr-core CLI)
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

4. Open herdr once so that its configuration folder exists.

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
  *Needs input*, *Working* and *Ready for review*. Click a task to open it live. Press the left arrow
  on an empty prompt to return to the list. **+** starts a new session in the projects folder. The
  check mark resolves a task: it is hidden from the panel, and the session is not stopped or deleted.

### Task notifications

The chat's tab runs `channels chat <channel>`. This starts the chat's Claude Code session and a small
listener alongside it. Every 3 seconds the listener reads Claude Code's records of the channel's
tasks (`~/.claude/jobs` and `~/.claude/sessions`).

- When a task finishes, the listener sends the chat a `[task report]` message containing the task's
  final message in full.
- When a task stops to ask a question or is waiting on a permission prompt, it sends a
  `[task question]` message.

Messages are pasted into the chat's herdr terminal with `hc send`, which waits until you stop typing.
The store records what has been reported for each task. Each event is reported once, and events
that happen while the chat is closed are delivered when it next opens.

To see what the listener would report right now, run `channels listen <channel> --once`.

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
channels start <channel> [--repo <project>] [--name <name>] [--model <model>] [--permission-mode <mode>] <brief | ->
channels file <channel> <session> [--name <name>] [--folder <path>]
channels read <session> [--limit <n>] [--json]
channels send <session> <text | ->
channels dismiss <session> [--by <who>]
channels listen <channel> --once
```

`channels send` can only reach a background task that has finished its turn. It stops the idle
session and resumes the same session with the message. Sending to a task that is still working, or
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
