# Cloud sessions as channel tasks: research

Can a channel start and track Claude Code cloud sessions (claude.ai/code, "Claude Code on the web") as
tasks, beside its local `claude --bg` tasks? Checked on 2026-11-19 with Claude Code 2.1.329 on Linux, signed in
to a claude.ai subscription. Tests used a throwaway public repo (now archived) and two harmless sessions.
Session ids below are shortened (`session_01…XXXX`).

**Short answer: partial.** Start and send work from the CLI and can be scripted. Nothing documented
lists, reads or reports a cloud session's state. Without that, the panel can't say "working", "asks
you" or "done", and no card can fire. Recommendation: **no-go on full parity for now**, **go on a small
"launch and link" version** if it's wanted (see the end).

| Capability | Verdict | How |
| --- | --- | --- |
| 1. Start | **Works** (needs a pty) | `script -qec 'claude --cloud "<brief>" -n "<title>"' /dev/null`; prints the session id and URL, then exits in about 3 s |
| 2. List with state | **No** (documented) / partial (undocumented) | No CLI, JSON or public API. `claude --teleport` shows a picker for the current repo with "Updated" times only. The CLI's own private `/v1/sessions` route exists but wasn't called |
| 3. Read latest message / waiting state | **Partial** | Only `claude --teleport <id>`, which copies the transcript into a local session. It needs a checkout of the repo |
| 4. Send | **Works** for an idle session; **no** while a question is open | `claude -p "<text>" --cloud <id> [--output-format json]` |
| 5. Open live | **Partial** | The claude.ai/code URL only. `claude --cloud <id>` (attach) is not enabled for this account. Teleport is a one-way copy |
| 6. Events (finish, question) | **No** | No push, webhook or hook. Polling has nothing documented to poll |
| 7. Limits | See below | Repo clone at the pushed branch, no local MCP or secrets, GitHub App or `gh` token, shared rate limits, org policy can turn it off |

## 1. Start

`--cloud` with `--print` is refused:

```
$ claude -p --cloud "Probe A: …" -n "cloud-probe A"
Error: --cloud cannot be combined with --print.
Starting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. To message an existing cloud session instead, pass its ID: `claude -p "message" --cloud <session-id>` (find IDs at claude.ai/code).
```

Without a terminal it is refused too:

```
$ claude --cloud "Probe C: …" -n "cloud-probe C" < /dev/null | cat
Error: --cloud requires an interactive terminal.
Non-interactive runs (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run in an interactive terminal.
```

With a pty it doesn't wait for input. Once the folder is trusted, it creates the session, prints three lines
and exits 0 in 2.7 s. The first run in a new folder shows the workspace trust dialog first. Channel folders
under `~/projects` are already trusted.

```
$ script -qec 'claude --cloud "Probe B: list the files … then ask me whether to delete README.md …" -n "cloud-probe B"' /dev/null
Created cloud session: cloud-probe B
View: https://claude.ai/code/session_01…XiTE?from=cli&m=0
Resume with: claude --teleport session_01…XiTE
Branch feature-x is not on GitHub, so the cloud session starts from its own commit, which origin/main has (e8333679270a).
```

- **Session id and URL**: printed, and easy to parse (`Created cloud session:`, `View:`). Neither is
  documented, so they could change.
- **Repo**: the current directory's GitHub remote. There is no flag for it. To pick a repo, `cd` to its
  checkout first. A folder with no remote, or a GitHub repo without the Claude GitHub App, is uploaded as a
  bundle (tracked files only; `CCR_FORCE_BUNDLE=1` forces it).
- **Branch**: the current branch if it is pushed. Otherwise it starts from the nearest commit the remote has,
  as above. Local commits that aren't pushed and uncommitted files are left out. `local.txt` (untracked)
  didn't reach the session. There is no `--ref` for Anthropic-hosted sessions. `--environment ccpool_… --ref`
  is for self-hosted environments only.
- **Working branch**: the session works on its own `claude/<slug>-<rand>` branch. When the brief names a
  branch, it uses that one: session A pushed `probe-a` as asked, and its commit says
  `Co-Authored-By: Claude …`.
- **Brief**: the description is the first user message. `-n` names the session.
- **Environment**: whatever `/remote-env` saved as `remote.defaultEnvironmentId`. There's no per-call flag.

## 2. List

- `claude agents --json --all` lists only local sessions (`kind`: `background` or `interactive`). Across 98
  rows, no cloud session appeared.
- `claude --help` and its subcommands have no list for cloud sessions. `claude --resume` doesn't list them
  either (the docs say so).
- `claude --teleport` without an id opens a picker of the current repo's cloud sessions, with an "Updated"
  time and a title. It shows no state:

  ```
    Teleport
    <owner>/cloud-probe
         Updated  Session title
    ❯ 1. 4s ago   cloud-probe B
      2. 1m ago   cloud-probe A
  ```

  The debug log shows it fetches every session and filters locally: `Filtered 2 sessions for repo
  <owner>/cloud-probe from 20 total`.
- **Undocumented route**: the CLI binary calls `GET {BASE_API_URL}/v1/sessions` (also `/v1/sessions/{id}`
  and `/v1/sessions/{id}/events`) with the claude.ai OAuth token, `anthropic-beta: ccr-byoc-2025-07-29` and
  `x-organization-uuid`. That is how the picker gets its list. I didn't call it: reading the OAuth token out
  of `~/.claude/.credentials.json` was blocked by the auto-mode classifier, and building on a private route
  with a scraped token is fragile. It breaks without notice, and a company laptop would rightly flag it. So
  its exact fields are unknown.
- **The claude.ai Agents MCP** (a self-hosted connector, `list_sessions`): lists what `claude agents --json` lists on
  the home server and its registered machines. It has no cloud sessions.
- **Docs** (code.claude.com/docs/en/claude-code-on-the-web): no command, JSON or public API lists cloud
  sessions with state. `/list-agents` in a Remote Control session shows "your cloud sessions" by name, with
  no state. The Compliance API's `GET /v1/compliance/apps/sessions/remote` lists Cowork and Claude Tag
  sessions and needs an admin key. It doesn't document Claude Code sessions.

## 3. Read

- The only reader is **teleport**: `claude --teleport <id>`, run in a checkout of the same repo. It checks
  out the session's branch if it was pushed, and loads the conversation into a new **local** session. From
  the local transcript, the existing code could then read the last message. Session B, after it asked its
  question:

  ```
  ❯ Probe B: list the files in the repo root and the current branch name, then ask me … whether to delete README.md …
    Ran 1 shell command
  ● Interrupted · no answer saved for Claude's questions:
    ⎿  · The repo root of cloud-probe (branch claude/probe-b-readme-deletion-a2or89) contains only README.md plus the .git directory. Should I
       delete README.md? (Keep README.md / Delete README.md)
  ● Session resumed without branch: Couldn't check out branch 'claude/probe-b-readme-deletion-a2or89'
  ```

  So the open question can be seen, but only as "Interrupted" in a copy. Teleport needs a clean tree and the
  same repo, makes a local session and transcript each time, and opens a TUI. It's no way to poll.
- `--output-format stream-json` isn't supported with `--cloud <id>` (docs).
- Permission prompts in a cloud session wait in that session. Nothing outside claude.ai/code can see or
  answer one.

## 4. Send

```
$ claude -p "No, keep README.md. Reply with the word done and stop." --cloud session_01…XiTE --output-format json
{"ok":true,"session_id":"session_01…XiTE","url":"https://claude.ai/code/session_01…XiTE?from=cli&m=0"}      # 0.8 s

$ claude -p "Reply with only the word pong. Change nothing." --cloud session_01…aAj
Sent to cloud session.
Session ID: session_01…aAj
View: https://claude.ai/code/session_01…aAj?from=cli&m=0

$ claude -p "hello" --cloud session_doesnotexist
Error: failed to send message to cloud session session_doesnotexist: invalid session ID: must be a cse_… or session_… tagged ID   # exit 1
```

- To an **idle** session (A, finished): it starts a turn. Teleport about 90 s later showed
  `❯ Reply with only the word pong…` / `● pong`.
- To a session **waiting on a question** (B, an AskUserQuestion dialog): it returns `ok:true`, but the
  message hadn't been taken about 4 minutes later. The question still showed unanswered. So `ok` means
  "queued", not "delivered". A channel can't answer a cloud task's question this way, and the card's Answer
  button would quietly do nothing.
- It returns at once, with no reply. The existing wake that reports into a cloud session depends on the same thing (`Sent to cloud session`).
- The docs give two more errors: an archived session ("is archived and cannot accept new messages") and
  `Session not found`.

## 5. Open live

- `claude --cloud <id>` (attach in the terminal): `Error: Attaching to an existing cloud session is not
  enabled for your account.` The docs call this out as an account-gated feature.
- `claude --teleport <id>`: a normal Claude Code TUI on a **local copy**. Work there stays local and never
  reaches the cloud session. It needs the repo checked out, the tree clean and the branch pushed. In a
  Herdr pane it looks exactly like a local session, which misleads. Not "open live".
- **The claude.ai/code URL is the best there is.** On a laptop it opens in the browser, and it is the same
  session as on the phone app. The panel's Open would call `open` (macOS) or `xdg-open` (Linux) on the URL
  instead of `claude attach`.

## 6. Events

- **Push**: none a script can use. Mobile push is documented for Remote Control sessions. The docs don't say
  cloud sessions send pushes. Nothing documented offers webhooks or callbacks for cloud sessions, and the
  `notify_when_idle` peer feature covers "your sessions on this machine" only.
- **Polling**: nothing documented to poll. The choices:
  1. The private `/v1/sessions` route (as in §2): one GET for all sessions every 30–60 s would be cheap and
     use no model, if its fields carry a status. Fragile, needs the OAuth token, and not tested here. Not
     recommended.
  2. **GitHub as the signal**: tell the session in the brief to push to `channels/<channel>/<task>` and
     open a draft PR when done. Then poll `gh` (one GraphQL query per minute for all cloud tasks; free, no
     model). This catches "pushed" and "PR opened" and CI, but never "asks a question" or "waiting on a
     permission", and a session that stops without pushing looks the same as one still working.
  3. Teleport per task: far too heavy (a TUI, a checkout and a local transcript per look).
- **Reverse report**: a cloud session can't message this machine back (cross-session docs: "Read the cloud
  session's response in its transcript at claude.ai/code"). Its claude.ai connectors do work, though. On
  the home server, a session could call the self-hosted Agents MCP to say it's done, but that doesn't help the work laptop.
- Side note: the cloud session's transcript showed a system hint about attaching "the user's own computer"
  (`list_computer_folders`, `request_computer_folder`). A cloud session can ask to use a folder on a machine
  connected through Remote Control. It's a separate feature, but relevant if the cloud task needs local files.

## 7. Limits

- **Code**: a fresh clone of the GitHub remote at the pushed branch. Unpushed commits and uncommitted or
  untracked files are left out, so the channel would have to push (or refuse) first. One repo per session.
  No access to `~/projects` siblings or other local files.
- **MCP and secrets**: only a committed `.mcp.json` and claude.ai connectors. `claude mcp add` at local or
  user scope doesn't carry over. Secrets go in the cloud environment's env vars (anyone using the
  environment can read them) or "network secrets". Network access is None, Limited (the default) or Full,
  set per environment. A setup script installs tools. User-level CLAUDE.md, skills and hooks from
  `~/.claude` don't come along. Only what's committed in the repo does.
- **GitHub account**: a session can clone any public repo. A private repo needs the Claude GitHub App
  installed on it, or the token from `gh auth token` saved with `/web-setup`. The identity is whichever
  GitHub account that is, tied to the **claude.ai account**, not to the machine. For a separate work GitHub
  account, the work org would have to install the Claude GitHub App (an org admin's decision), or the work
  account would have to be the `gh` login when `/web-setup` runs, which swaps it for every cloud session on
  that claude.ai account. The bundle upload works with no GitHub at all, but it sends the repo to Anthropic.
  A company may forbid that.
- **Plan and rate limits**: Pro, Max, Ultra and Team plans, and Enterprise with premium or Claude Code seats.
  Cloud sessions share rate limits with all other Claude and Claude Code use on the account. The status
  line during the tests read `7d:74%`. Not on Bedrock, Vertex or Foundry, and not for orgs with ZDR, HIPAA
  or CMEK.
- **What an admin can block**: the org policy `allow_remote_sessions` (error: "Cloud sessions are disabled by
  your organization's policy"), and custom roles without the cloud sessions permission. On a company laptop
  signed in to a company Claude org, the admin decides. Endpoint-managed settings don't reach cloud sessions,
  so the laptop's own MDM can't loosen or tighten what runs in the cloud. Egress firewalls that block
  claude.ai or api.anthropic.com would stop `--cloud` too.
- **Lifecycle**: there's no CLI stop or archive. Archive is in the claude.ai/code UI ("⋯" → Archive). An
  idle session waits "up to environment expiry", and the docs give no number.

## Recommendation

**No-go on cloud tasks as full peers of local tasks.** What makes channels useful is the state, cards and
answers, and none of that exists for cloud sessions without a private API. Revisit when one of these ships:
`claude agents --json` listing cloud sessions, a documented sessions list and read, or a working
`claude --cloud <id>` attach. Any of them turns most of the "no" rows above into "works". The first is
the simplest to watch for: check `claude agents --json --all` for a `kind` other than `background` and
`interactive` after each Claude Code update.

**Go, if wanted, on a small "launch and link" version.** It's useful today for "keep going with the lid shut,
follow from the phone".

### Sketch: `channels start --cloud`

```
channels start <channel> --cloud [--repo <project>] [--title <t>] "<brief>"
```

1. Refuse if the repo's current branch isn't pushed or the tree is dirty ("push first: the cloud copy starts
   from GitHub"). Otherwise the cloud session silently starts from older code.
2. Run `claude --cloud "<brief + branch line>" -n <title>` under a pty (`script -qec … /dev/null` on Linux,
   `script -q /dev/null …` on macOS), with `cwd` the repo. Parse `Created cloud session:` and
   `View: <url>` from the output, the same way `start` parses `backgrounded · <job>` now. The brief gets one
   added line: *"Work on branch `channels/<channel>/<short id>`, push it, and open a draft PR when you're
   done."*
3. Store the task like a local one, with a `cloud` block instead of `job`:

   ```json
   {
     "machine": "cloud", "session_id": "session_01…", "job": null,
     "name": "Fix the footer", "repo": "website", "folder": null,
     "cloud": { "url": "https://claude.ai/code/session_01…", "branch": "channels/website/a1b2c3",
                "github": "owner/website", "pr": null, "last_push": null, "ci": null },
     "added_at": "…", "how": "started", "dismissed_at": null, "dismissed_by": null, "told": null
   }
   ```

   `machine: "cloud"` keeps the existing `<machine>/<session id>` naming (`cloud/session_01…`) and tells
   every reader that the local job records don't apply.

**Panel**: a cloud row has a cloud glyph and a state taken from GitHub only: *started* → *pushed* (last push
time) → *PR open* (with CI ✓/✗) → *merged*. It also shows a muted "check the web for questions". Open runs
`open`/`xdg-open` on the URL. Send uses `claude -p … --cloud <id>` and warns that a session waiting on a
question won't take it.

**Cards**: only "PR opened" (as a finish, with a CI line) and "CI failed". There are no question cards: they
can't be detected, and an answer couldn't be delivered.

**Polling**: in the existing listener, every 60 s while any cloud task is open, one `gh api graphql` call for
all of them (branch head and PR with checks). It costs no model tokens and stays well inside GitHub's rate
limit. It fires the existing ride-along and wake events with the same `told` marks.

**Size**: about 300–400 lines in `bin/channels.mjs` plus the panel and mod changes (a cloud row, Open by URL,
no Answer), with tests. 1.5–2 days. Full parity on the private `/v1/sessions` route would add about a day,
but it is not recommended.

Sources: code.claude.com/docs/en/claude-code-on-the-web, …/cloud-environments, …/cli-reference,
…/cross-session-messaging, …/remote-control; platform.claude.com/docs/en/api/compliance/apps/sessions/remote/list.
