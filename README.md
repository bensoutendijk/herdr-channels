# herdr-channels

Channels for the [herdr](https://herdr.dev) app, running entirely on this Mac. A channel is a
workstream: a sidebar entry with an icon, a description, one long-lived Claude Code chat, and the
tasks the chat (or you) started for it. A task is one Claude Code background session (`claude --bg`),
shown live in the tasks panel beside the chat.

There is no server and no other machine. The store is a folder on this Mac, the sessions are this
Mac's `claude`, and the herdr mod runs every command locally.

What's here:

- `mods/channels/` and `layouts/channels.json`: the herdr front end (sidebar, bar, tasks panel,
  dialogs) and the layout that shows it.
- `bin/channels.mjs`: the `channels` command, one Node script with no dependencies. The mod and
  the chats use it.
- `install.mjs`: puts both in place.
- `test/`: the command's and the install's tests (`node --test test/*.test.mjs`).

## Requirements

- **The herdr app**, opened once (it makes `~/.config/herdr-app` and brings `hc`, herdr-core).
- **Node 20 or later**: `brew install node`.
- **Claude Code**, signed in: `claude --version` works in a terminal.
- **python3**, for the task viewer. macOS's `/usr/bin/python3` comes with the Xcode Command Line
  Tools, which Homebrew installs anyway.
- **git** and access to this repo (`gh auth login`).

## Install

1. Install Node and the GitHub CLI, and sign in to GitHub:

   ```sh
   brew install node gh
   gh auth login
   ```

2. Clone this repo into `~/projects` and keep it there (the `channels` command runs from the clone):

   ```sh
   mkdir -p ~/projects && cd ~/projects
   gh repo clone bensoutendijk/herdr-channels
   ```

3. Let Claude Code start sessions in `~/projects`. Background sessions start only in a folder you
   trust, so run `claude` there once, accept the trust prompt, then type `/exit`:

   ```sh
   cd ~/projects && claude
   ```

4. Open the herdr app once, so its folder exists, and quit it again or leave it open.

5. Install:

   ```sh
   node ~/projects/herdr-channels/install.mjs
   ```

   It writes `~/.local/bin/channels`, copies the mod and layout into `~/.config/herdr-app` (renaming
   the copy, e.g. to `channels-2`, if that name is already taken: nothing of yours is overwritten),
   and selects the channels layout. Options: `--by <name>` (who resolving a task in the panel is
   recorded as; default `user`), `--projects <dir>` (default `~/projects`), `--store <dir>`
   (default `~/.local/state/herdr-channels`), `--bin <dir>`, `--app-home <dir>`, `--no-switch`,
   `--dry-run`.

6. Put `~/.local/bin` on your PATH if it isn't, so `channels` works in a terminal too (the mod and
   the chats find it either way):

   ```sh
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
   ```

7. Check it:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/channels
   channels create general
   channels list
   ```

   In herdr, the channels layout shows `#general` in the sidebar. Click it to open its chat.
   `ctrl-shift-l` switches layouts.

To update later:

```sh
cd ~/projects/herdr-channels && git pull && node install.mjs
```

## Using it

- **New channel** at the bottom of the sidebar. The `···` menu on a channel renames it, edits its
  instructions (the description its chat reads at launch), changes its icon or archives it. Drag
  channels to reorder them.
- **The chat** fills the main area. Ask it to start work: it runs `channels start <channel> -` with
  a brief that stands on its own, and the task appears in the panel on the right.
- **The tasks panel** (the button at the top right) lists the channel's tasks by where they stand:
  needs input, working, ready for review. Click one to open it live; the left arrow on an empty
  prompt goes back to the list. **+** starts a fresh session in the projects folder. The check mark
  resolves (dismisses) a task; it never stops or deletes the session.

### How the chat hears its tasks

`channels chat <channel>`, which the chat's tab runs, starts the chat's `claude` and, beside it,
looks at the channel's tasks in Claude Code's own records (`~/.claude/jobs`, `~/.claude/sessions`)
every 3 seconds. When a task finishes, its last message goes to the chat whole, as a message opening
with `[task report]`; when a task stops to ask something (a question at the end of its turn, or a
permission prompt), a `[task question]` goes the same way. The message is pasted into the chat's own
herdr terminal with `hc send`, which waits while you're typing there. The store remembers what each
task was last reported as, so nothing arrives twice, and a report that came in while the chat was
closed arrives when it opens again. `channels listen <channel> --once` prints what the chat would be
told right now.

## The command

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

`send` reaches a background task whose turn is over: it stops that session's idle process and
resumes the same session with the message. A task that is still working, or showing a prompt,
refuses; answer a prompt in the task's view.

Environment: `CHANNELS_DIR` (the store), `CHANNELS_PROJECTS` (the projects folder),
`CHANNELS_MACHINE` (the name tasks are filed under; default the host name),
`CHANNELS_PERMISSION_MODE` (for `start`; default `auto`, empty for Claude Code's own default),
`CHANNELS_CLAUDE` and `CHANNELS_HC` (the programs to run). The installed `~/.local/bin/channels`
sets the first two to what the install was given.

The mod's settings are in `~/.config/herdr-app/mods/channels/config.js`, written by the install:
the command's path, the folders for PATH, the projects folder and the `--by` name.

## Uninstall

```sh
rm ~/.local/bin/channels
rm -r ~/.config/herdr-app/mods/channels ~/.config/herdr-app/layouts/channels.json
```

The store (`~/.local/state/herdr-channels`) and the sessions are left; remove them by hand if you
want them gone.
