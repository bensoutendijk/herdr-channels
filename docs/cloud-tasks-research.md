# Cloud sessions as channel tasks: research

Can a channel start and track Claude Code cloud sessions (claude.ai/code, "Claude Code on the web") as
tasks, beside its local `claude --bg` tasks? Checked on 2026-11-19 with Claude Code 2.1.329 on Linux, signed in
to a claude.ai subscription. Tests used a throwaway public repo (now archived) and two harmless sessions.
Ids below are shortened (`session_01…XXXX`), and repo owners read `<owner>`.

**Short answer: go, on an undocumented API.** Everything a channel needs exists and was tested:
- Start and send are plain CLI commands.
- One HTTP call lists every cloud session with its state, including "waiting on a human", a one-line summary
  and the cost.
- A server-sent event stream pushes a session's events.
- Attaching opens a session live in a terminal, questions included.

The catch: the list call and the event stream are Claude Code's private API, called with the user's claude.ai
sign-in. Live attach is behind a server-side rollout flag that is off for this account today. Plan for both to
change without notice. Details and a design are at the end.

| Capability | Verdict | How |
| --- | --- | --- |
| 1. Start | **Works** (needs a pty) | `script -qec 'claude --cloud "<brief>" -n "<title>"' /dev/null`; prints the session id and URL, then exits in about 3 s |
| 2. List with state | **Works** (undocumented) | `GET https://api.anthropic.com/v1/code/sessions` with the claude.ai sign-in: `worker_status` `idle`, `running` or `requires_action`, plus `status_bucket` and `post_turn_summary`. In a session: the `ListAgents` tool or `/list-agents`, when connected to Remote Control |
| 3. Read latest message / waiting state | **Works** (undocumented) | The same list's `post_turn_summary` (`recent_action`, `needs_action`, `status_detail`) and `status_line`. The event stream for the full messages. `claude --teleport <id>` for a local copy |
| 4. Send | **Works**, but doesn't answer an open question | `claude -p "<text>" --cloud <id> --output-format json`. Behind an open question, the text waits as a new message until the question is answered |
| 5. Open live | **Works behind a flag** | `claude --cloud <id>` attaches in a terminal, with dialogs. It needs the rollout flags `tengu_remote_backend` / `tengu_violin_maple`, which are off for this account. Otherwise the claude.ai/code URL |
| 6. Events (finish, question) | **Works** (undocumented) | Poll the list every 15–30 s (one call for all sessions, no model), or follow `GET /v1/code/sessions/{id}/events/stream?from_sequence_num=N` (SSE) |
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

With a pty it doesn't wait for input. Once the folder is trusted, it creates the session, prints three lines and
exits 0 in 2.7 s. The first run in a new folder shows the workspace trust dialog first. Channel folders under
`~/projects` are already trusted.

```
$ script -qec 'claude --cloud "Probe B: list the files … then ask me whether to delete README.md …" -n "cloud-probe B"' /dev/null
Created cloud session: cloud-probe B
View: https://claude.ai/code/session_01…XiTE?from=cli&m=0
Resume with: claude --teleport session_01…XiTE
Branch feature-x is not on GitHub, so the cloud session starts from its own commit, which origin/main has (e8333679270a).
```

- **Session id and URL**: printed, and easy to parse (`Created cloud session:`, `View:`). Neither is
  documented, so they could change.
- **Repo**: the current directory's GitHub remote. There is no flag for it. To pick a repo, `cd` to its checkout
  first. A folder with no remote, or a GitHub repo without the Claude GitHub App, is uploaded as a bundle
  (tracked files only; `CCR_FORCE_BUNDLE=1` forces it).
- **Branch**: the current branch if it is pushed. Otherwise it starts from the nearest commit the remote has, as
  above. Local commits that aren't pushed and uncommitted files are left out. `local.txt` (untracked) didn't
  reach the session. There is no `--ref` for Anthropic-hosted sessions. `--environment ccpool_… --ref` is for
  self-hosted environments only.
- **Working branch**: the session works on its own `claude/<slug>-<rand>` branch. When the brief names a branch,
  it uses that one: session A pushed `probe-a` as asked, and its commit says `Co-Authored-By: Claude …`.
- **Brief**: the description is the first user message. `-n` names the session.
- **Environment**: whatever `/remote-env` saved as `remote.defaultEnvironmentId`. There's no per-call flag.
- **The two ids**: the CLI prints `session_…`. The API lists the same session as `cse_…`, with the same suffix.
  `claude -p --cloud` takes either.

## 2. List

### The sessions API (what the CLI itself uses)

The teleport picker, `/list-agents` and the `ListAgents` tool all fetch `GET /v1/sessions`. The strings in the
binary show that when that route is retired, the CLI repeats the call on `/v1/code/sessions`. The request:

```
GET https://api.anthropic.com/v1/code/sessions?limit=5
authorization: Bearer <claude.ai OAuth access token>
anthropic-version: 2023-06-01
anthropic-beta: ccr-byoc-2025-07-29
x-organization-uuid: <oauthAccount.organizationUuid from ~/.claude.json>
```

The token needs the `user:sessions:claude_code` scope. A normal `claude auth login` has it (`user:file_upload
user:inference user:mcp_servers user:plugins user:profile user:sessions:claude_code`). A `claude setup-token`
token does **not**: setup-token logs in with `inferenceOnly: true`. So a script has to use the token Claude Code
already stores. That's `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, mode 600) on Linux, and the
login Keychain item `Claude Code-credentials` on macOS (not tried on a Mac). Claude Code refreshes it, and a copy
kept elsewhere goes stale. Auto mode refuses to let an agent run anything that reads that file, so the user ran
the probe themselves (`ccs.mjs`: read-only GETs, token never printed).

The response (shortened, one cloud session; ids and owner redacted):

```json
{"data":[{
  "id": "cse_01…aAj", "title": "cloud-probe A",
  "environment_kind": "anthropic_cloud", "environment_id": "env_01…",
  "status": "active", "status_bucket": "completed", "worker_status": "idle", "connection_status": "connected",
  "status_line": "declined second file; probe-a keeps only h…",
  "created_at": "2026-11-19T20:04:16.99Z", "last_event_at": "2026-11-19T21:04:09.14Z", "unread": true,
  "config": {"model": "claude-opus-5-5", "origin": "claude_code_cli",
             "sources": [{"type": "git_repository", "url": "https://github.com/<owner>/cloud-probe", "revision": "main"}],
             "outcomes": [{"type": "git_repository", "git_info": {"repo": "<owner>/cloud-probe", "branches": ["probe-a"]}}]},
  "external_metadata": {
    "current_branches": {"": "probe-a"},
    "post_turn_summary": {"status_category": "completed", "needs_action": "",
                          "recent_action": "User answered No to adding a second file, so probe-a still contains only hello.txt",
                          "status_detail": "declined second file; probe-a keeps only hello.txt"},
    "usage": {"cost_usd": 0.290234, "input_tokens": 524, "output_tokens": 1010, "cache_read_tokens": 618401},
    "context_usage": {"used_tokens": 81079, "max_tokens": 1000000},
    "rate_limit_info": {"rateLimitType": "seven_day", "status": "allowed", "isUsingOverage": false}}
}, …]}
```

What a channel needs from it:

- **`environment_kind`**: `anthropic_cloud` for a cloud session. The list also has `bridge` rows, which are
  Remote Control sessions on the user's machines, each with `worktree_state` (branch, head, dirty).
- **`worker_status`**: `idle`, `running` or `requires_action`. The CLI's peer list prints `requires_action` as
  "waiting on a human" (`B(e,t){return e==="requires_action"?"waiting on a human":t}`). The others show as
  idle and busy.
- **`status`**: `active` or `archived`.
- **`status_bucket`**: seen as `completed` and `review_ready`. The strings near it in the binary also include
  `working`, `blocked`, `failed` and `done`.
- **`post_turn_summary`**: a model-written line per turn. `recent_action` is what it did, `needs_action` is what
  it needs from the user (empty when nothing), and `status_category` is the kind of state.
  This is a ready-made card text.
- **`usage.cost_usd`**: so the panel can show cost, as it does for local tasks.

### The same list, seen from inside Claude Code

In an interactive session connected to Remote Control, `/list-agents` and the `ListAgents` tool list cloud
sessions with their state. With A's question open:

```
cloud-probe A [58ea2d]  ·  cloud  ·  waiting on a human
cloud-probe B [577ddf]  ·  cloud  ·  idle
```

`claude -p` doesn't get them, not even with `--remote-control`. It listed only the 24 local sessions. So this is no
route for a script, but a channel's chat (an interactive session) could see its cloud tasks this way.

### Ruled out

- `claude agents --json --all` lists local sessions only. Across 98 rows, no cloud session appeared. Agent view
  (`claude agents`) also shows local ones only.
- `claude --resume` doesn't list cloud sessions. The binary has a "list cloud sessions in resume" path, but it
  hangs on a `cloudSessionsByDefault` value compiled to `false` in this build.
- `claude --teleport` with no id opens a picker for the current repo's cloud sessions, with an "Updated" time
  and a title only.
- `/tasks` doesn't show cloud sessions.
- The claude.ai Agents MCP is a self-hosted connector that lists what `claude agents --json` lists. It has no
  cloud sessions.
- Docs (code.claude.com/docs/en/claude-code-on-the-web): no documented command, JSON or public API lists cloud
  sessions with state. The Compliance API's remote-sessions list covers Cowork and Claude Tag and needs an
  admin key.

## 3. Read

- **State and a summary**: from the list (§2). `post_turn_summary.recent_action` and `needs_action` are short and
  fit a card. When a question is open, `worker_status` is `requires_action`. This test didn't capture whether
  `needs_action` then holds the question's text.
- **Full messages**: the attached view (§5) reads `GET /v1/code/sessions/{id}/events/stream?from_sequence_num=N`, a
  server-sent event stream that starts from a sequence number, so a reader can replay from where it left off.
  Seen in the attach debug log; its event format wasn't decoded here.
- **Teleport** (`claude --teleport <id>`, in a checkout of the same repo) copies the conversation into a new
  local session, the open question included:

  ```
  ● Interrupted · no answer saved for Claude's questions:
    ⎿  · The repo root of cloud-probe (branch claude/probe-b-readme-deletion-a2or89) contains only README.md plus the .git directory. Should I
       delete README.md? (Keep README.md / Delete README.md)
  ● Session resumed without branch: Couldn't check out branch 'claude/probe-b-readme-deletion-a2or89'
  ```

  It needs a clean tree and the same repo, and makes a local session each time. It's no way to poll.

## 4. Send

```
$ claude -p "Reply with only the word pong. Change nothing." --cloud session_01…aAj
Sent to cloud session.
Session ID: session_01…aAj
View: https://claude.ai/code/session_01…aAj?from=cli&m=0

$ claude -p "No, keep README.md. …" --cloud session_01…XiTE --output-format json
{"ok":true,"session_id":"session_01…XiTE","url":"https://claude.ai/code/session_01…XiTE?from=cli&m=0"}      # 0.8 s

$ claude -p "hello" --cloud session_doesnotexist
Error: failed to send message to cloud session session_doesnotexist: invalid session ID: must be a cse_… or session_… tagged ID   # exit 1
```

- **To an idle session**: it starts a turn. Session A answered `pong` within about 90 s.
- **To a session with a question open**: `ok:true`, but the question stays open. The text joins the conversation
  as a new user message behind the dialog (`❯ 2` showed above A's dialog). Once the question was answered in the
  attached pane, the session read both. So `-p` can't answer a card's question. Answering needs the attached
  pane, or claude.ai/code.
- It returns at once, with no reply. The docs add errors for an archived session ("is archived and cannot accept
  new messages") and `Session not found`.

## 5. Open live

- **`claude --cloud <id>` attaches**, but only with the rollout flags on. With them off, the CLI refuses before
  asking the server:

  ```
  Error: Attaching to an existing cloud session is not enabled for your account.
  ```

  The check in the CLI is `de = q===undefined && (v || b("tengu_remote_backend",!1) || await uZt())`, where
  `uZt()` reads the gate `tengu_violin_maple` ("connected sessions"). `v` would come from a "cloud sessions by
  default" setting that is compiled out in this build. The CLI caches both flags in `~/.claude.json`
  (`cachedGrowthBookFeatures`, `cachedFeatureFlags`). For this account the server sends `tengu_violin_maple:
  false` and doesn't send `tengu_remote_backend` at all.
- **Test, one run, with the user's OK**: both keys were set to `true` in that cache, one attach was started, and
  the keys were put back right after (the file was backed up first and checked to parse). The server accepted the
  attach:

  ```
  ● Attached to cloud session · code here or at https://claude.ai/code/session_01…aAj?from=cli&m=0
  ```

  It's a full Claude Code TUI on the cloud session: the transcript, a prompt, `◎ cloud` in the status line, and
  live turns. A question the session asked showed as a normal dialog:

  ```
   ☐ Second file
  Should I add a second file to the probe-a branch (alongside hello.txt)?
  ❯ 1. Yes, add one
    2. No
    3. Type something.
  ```

  Arrow keys and Enter answered it, and the session went on. `/exit` leaves the attached view (here it went on
  to agent view). The cloud session keeps running.
- `CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES` does **not** force flags in a normal run. It only allows flags that a
  `claude plugin eval` case seeds into its child.
- **How to tell when it's on for real**: `tengu_violin_maple` (or `tengu_remote_backend`) turns `true` in
  `~/.claude.json`'s `cachedGrowthBookFeatures`, and `claude --cloud <id>` stops printing the error above. Until
  then, forcing it means editing a cache that every running Claude Code session rewrites. That's fine for a test,
  not for a product.
- **Without the flag**: the claude.ai/code URL (`open` or `xdg-open`). It's the same session as on the phone.
  `claude --teleport <id>` is a one-way local copy: work there never reaches the cloud session, so it isn't
  "open live".

## 6. Events

- **Polling the list**: one `GET /v1/code/sessions` returns every session with `worker_status`, `last_event_at`,
  `post_turn_summary` and the cost. That's one small HTTPS call and no model tokens. Every 15–30 s while a channel
  has an open cloud task, then:
  - **finished**: `worker_status` goes from `running` to `idle` and `last_event_at` moves. The card text is
    `post_turn_summary.recent_action`.
  - **asks you**: `worker_status` is `requires_action`. The card text is `needs_action`, or "asks you something"
    with Open.
  - **gone**: `status` is `archived`.

  The mark that stops a repeat is `last_event_at` plus `worker_status`, kept with the task the way `told` is kept
  now.
- **Push**: `GET /v1/code/sessions/{id}/events/stream?from_sequence_num=N` (SSE) is what the attached view
  follows. One stream per open cloud task would make events instant, but it means long-lived connections, token
  refresh mid-stream, and decoding the event format. Polling is enough to start.
- **Not available**: webhooks, hooks that run on this machine, or mobile push to a script. `notify_when_idle`
  covers local sessions only.
- Side note: the cloud session's transcript showed a system hint about attaching "the user's own computer"
  (`list_computer_folders`, `request_computer_folder`). A cloud session can ask to use a folder on a machine
  connected through Remote Control. It's a separate feature, but relevant when a cloud task needs local files.

## 7. Limits

- **Code**: a fresh clone of the GitHub remote at the pushed branch. Unpushed commits and uncommitted or untracked
  files are left out, so the channel has to push (or refuse) first. One repo per session. No access to sibling
  repos or other local files.
- **MCP and secrets**: only a committed `.mcp.json` and claude.ai connectors. `claude mcp add` at local or user
  scope doesn't carry over. Secrets go in the cloud environment's env vars (anyone using the environment can read
  them) or "network secrets". Network access is None, Limited (the default) or Full, set per environment. A setup
  script installs tools. User-level CLAUDE.md, skills and hooks from `~/.claude` don't come along. Only what's
  committed in the repo does.
- **GitHub account**: a session can clone any public repo. A private repo needs the Claude GitHub App installed on
  it, or the token from `gh auth token` saved with `/web-setup`. The identity is whichever GitHub account that is,
  tied to the **claude.ai account**, not to the machine. For a separate work GitHub account, the work org would
  have to install the Claude GitHub App (an org admin's decision), or the work account would have to be the `gh`
  login when `/web-setup` runs, which swaps it for every cloud session on that claude.ai account. The bundle upload
  works with no GitHub at all, but it sends the repo to Anthropic. A company may forbid that.
- **Plan and rate limits**: Pro, Max, Ultra and Team plans, and Enterprise with premium or Claude Code seats.
  Cloud sessions share rate limits with all other Claude and Claude Code use on the account. Each session's
  `rate_limit_info` shows the 7-day window it counts against. Not on Bedrock, Vertex or Foundry, and not for orgs
  with ZDR, HIPAA or CMEK.
- **What an admin can block**: the org policy `allow_remote_sessions` (error: "Cloud sessions are disabled by your
  organization's policy"), and custom roles without the cloud sessions permission. On a company laptop signed in
  to a company Claude org, the admin decides. Endpoint-managed settings don't reach cloud sessions. Egress
  firewalls that block claude.ai or api.anthropic.com stop `--cloud` too. Reading Claude Code's stored login from
  another program may also trip endpoint security on a managed Mac (a Keychain prompt at the least).
- **Lifecycle**: there's no CLI stop or archive. Archive is in the claude.ai/code UI ("⋯" → Archive). The list
  shows `status: archived` afterwards. An idle session waits "up to environment expiry", and the docs give no
  number.

## Recommendation

**Go, as an opt-in that says it rides on Claude Code's private API.** With the list call, a cloud task can be a
near-peer of a local one: the panel state (working, asks you, done), cards with a real summary, send, and cost.
Two things stay weaker than local tasks:
- **Open** is the claude.ai/code URL until the attach flag reaches the account. Then it is `claude --cloud
  <id>` in a pane, like `claude attach` today.
- **A card's Answer** can't reach a cloud question. A cloud question's card offers Open only.

Risks to accept:
- **The API is private.** `/v1/sessions` is already "retired" in favour of `/v1/code/sessions`, the beta header
  is dated, and the field names could change. Keep it behind one small module, and when a call fails, fall back
  to "state unknown, open on the web" instead of breaking the panel.
- **It needs the stored claude.ai login.** That means reading Claude Code's credentials file, or the Keychain on
  a Mac. On the personal Mac that's fine. On a work laptop it may not be allowed, so it should be a setting that
  is off by default.
- **Watch for a supported route.** When `claude agents --json` lists cloud sessions, or `claude --cloud <id>`
  attaches without the error, switch to that and drop the private calls.

### Sketch: `channels start --cloud`

```
channels start <channel> --cloud [--repo <project>] [--title <t>] "<brief>"
```

1. Refuse if the repo's current branch isn't pushed or the tree is dirty ("push first: the cloud copy starts from
   GitHub").
2. Run `claude --cloud "<brief>" -n <title>` under a pty (`script -qec … /dev/null` on Linux,
   `script -q /dev/null …` on macOS), with `cwd` the repo. Parse `Created cloud session:` and `View: <url>`, the
   way `start` parses `backgrounded · <job>` now.
3. Store the task like a local one, with a `cloud` block instead of `job`:

   ```json
   {
     "machine": "cloud", "session_id": "session_01…", "job": null,
     "name": "Fix the footer", "repo": "website", "folder": null,
     "cloud": { "url": "https://claude.ai/code/session_01…", "worker_status": "running",
                "last_event_at": null, "summary": null, "needs": null, "cost_usd": null, "status": "active" },
     "added_at": "…", "how": "started", "dismissed_at": null, "dismissed_by": null, "told": null
   }
   ```

   `machine: "cloud"` keeps the existing `<machine>/<session id>` naming and tells every reader that the local
   job records don't apply. `channels file` can also take a `session_…`, `cse_…` or claude.ai/code URL, to adopt
   a cloud session started elsewhere (the phone, the web).

**Listener**: a `cloud.mjs` module with one function, `listCloudSessions()`, that reads the stored login (Linux
file, macOS Keychain), calls `GET /v1/code/sessions` (and pages if needed), and returns `{ id, worker_status,
status, last_event_at, summary, needs, cost_usd }` for `anthropic_cloud` rows. The listener calls it every 20 s
while any channel has an open cloud task, maps `session_…` ⇄ `cse_…`, and turns changes into the events it already
delivers (panel dot, ride-along, wake), with the same `told` marks. On 401 it waits for Claude Code to refresh the
login. Any other failure marks cloud tasks "state unknown" until the next good call.

**Panel**: a cloud row has a cloud glyph and the same states as local tasks (working, asks you, done), plus the
cost. Open runs `claude --cloud <id>` in a pane when the attach flag is on, else `open`/`xdg-open` on the URL. Send
uses `claude -p … --cloud <id>`, and warns when the task is `requires_action` that the text waits behind the
question.

**Cards**: "finished" with `recent_action`, and "asks you" with `needs_action` and Open (no Answer select). Tell
chat works as now.

**Size**: about 450–600 lines across `bin/channels.mjs`, a new `bin/cloud.mjs`, the panel and the cards mod, with
tests that stub the HTTP call. 2–3 days. The SSE stream instead of polling would add about a day, and isn't needed
to start.

Sources: code.claude.com/docs/en/claude-code-on-the-web, …/cloud-environments, …/cli-reference,
…/cross-session-messaging, …/remote-control; platform.claude.com/docs/en/api/compliance/apps/sessions/remote/list;
strings in the Claude Code 2.1.329 binary; and the tests above.
