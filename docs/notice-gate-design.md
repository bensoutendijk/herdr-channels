# Notice gate: when a task wakes its chat

A task event wakes the chat only when the chat asked for that turn, the task is blocked, or something failed. Free rules
settle most events; a Haiku judge decides the rest, and anything held goes into a short catch-up.

## How others decide

| Product | Interrupt when | Batch / drop | User control |
|---|---|---|---|
| Claude Duet | Something needs you: a task finished or needs review; anything irreversible waits for your OK | Checks accounts every few hours; a daily morning brief covers the rest. Its scoring isn't public and is "still being tuned" | Plain words: what you want to hear about, and how often |
| GitHub | Every event whose *reason* is yours: `mention`, `review_requested`, `assign`, `author`, `ci_activity` (a run *you* triggered), `state_change`, `approval_requested`, `agent_session_finished` | Watching (`subscribed`) goes to the inbox, not push. No digest; items expire after 3 months | Routes by reason (inbox, email, push); per-thread unsubscribe; per-repo watch level |
| Slack | DMs, @mentions and keywords ("Mentions & DMs" mode); VIPs on mobile | Everything else is an unread badge only. "Catch up" recaps: not confirmed in what we read | Everything or mentions only, per-channel overrides, keywords, notification schedule |
| Linear | Real time, only on issues you're subscribed to (created, assigned, @mentioned); urgent or blocking status changes | Everything lands in the Inbox. Email is immediate or a digest, delayed by urgency, and skipped if you've already read it | Per channel × per event type; snooze; a filtered Priority tab |
| iOS | Time Sensitive and allowed people or apps break through a Focus. "Reduce Interruptions" lets through what the model rates important | Scheduled Summary: a bundle at set times, most important first. Everything stays in Notification Center (nothing is truly dropped) | Allow and silence lists that override the model; Focus schedules |
| Claude Code background agents | A finished subagent reports to the session that started it, as an automated event in a later turn (never mid-answer). Its permission prompts show in the main session | Nothing is batched; one report per finish. A background command's exit notifies the agent that ran it, not the main session | Wait vs. background (fork off), stop, resume |

**What they share:** the interrupt follows *whose* it is (GitHub's reasons, Linear's subscriptions, Claude Code's "the one who started it"),
plus *urgency* (Time Sensitive, blocking, approvals). Everything else is batched into an inbox or summary. Almost nothing is
truly dropped: it's demoted to a place you can still look. Where a model rates importance (iOS, Duet), people's explicit
lists override it, and the model's judgment is the part users trust least.

## The gate

| Layer | Decides | Signals | Cost |
|---|---|---|---|
| 0. Dedupe (exists) | Drop repeats | `told` mark, event key | Free |
| 1. Rules | Most events: quiet, wake now, card only, hold. Sends the rest to layer 2 | Who started the turn (`asked`: chat via `start`/`send`; `--by user` from the panel; else Ben typed it); registration (`wake`); kind (finish, question or hand-off, permission prompt, Codex approval, **failed**); Ben looking at the task (open in the panel now, or typed there in the last 5 min); started by a routine; channel `notify` presets | Free, in the listener tick |
| 2. Judge (Haiku) | Chat-started *ordinary* finishes only: wake, hold, drop | The brief (the ask's text), the turn's result (cut to ~2k chars), the chat's last few exchanges (~1.5k), the channel's `notify` words, how many are held | ~$0.0002 per call at API rates (Haiku 5.5: $0.10/$0.50 per MTok, ~1.5k in and 60 out). Through `claude -p` on Ben's sign-in, its own prompt adds ~10k cached tokens: still well under a cent. 3–8 s, off the tick |
| 3. Catch-up | Where held events go | The `held` list on the channel | Free when it rides along; one chat turn for a scheduled brief |

### Layer 1 rules, in order (first match wins)

| # | If | Then |
|---|---|---|
| 1 | Repeat of the last event | Drop (today) |
| 2 | Registration matches (`watch`, `--wake-on`) | Wake now, whoever started the turn |
| 3 | Permission prompt or Codex approval | Card + dot. Rides along only if the chat started the turn. Never wakes the chat (it can't answer one) |
| 4 | Ben typed the turn (no `asked` before its end) | Panel only (dot, ready for review, its card if it asks). No ride-along: he was there |
| 5 | Sent from the panel (`--by user`) | Hold: Ben asked, so it's his to review. The chat learns at catch-up |
| 6 | Chat's turn ended **failed** (job `failed`, API error, process gone) | Wake now |
| 7 | Chat's turn ended asking (question, hand-off) | Wake now ("needs you", today's notice) |
| 8 | `notify` preset says `all` | Wake now (today's behaviour) |
| 9 | Chat's turn finished while Ben is looking at the task | Hold: he saw it, but the chat may still need the result |
| 10 | Chat's turn finished | → Judge |
| 11 | No `asked` record (filed task, legacy) | Hold |

### Layer 2 judge

| Aspect | Design |
|---|---|
| Runs where | The listener (Node, no deps) spawns `claude -p --model haiku --output-format json`, with no tools, no MCP servers and no settings, on Ben's own sign-in (agent-os's wake already fires routines this way). No API key to manage on a work laptop |
| Async | The tick records `judging: {since}` on the task and moves on; a later tick reads the result. The chat is never blocked: notices only land when it's idle anyway |
| Output | `{"do":"wake"|"hold"|"drop","why":"≤12 words","line":"≤120 chars","rule":<index or null>}`, checked against a schema. Anything else counts as a failure |
| Guards | `drop` is accepted only when `rule` cites one of the channel's `notify` lines; otherwise it becomes `hold`. The judge never sees questions, failures or prompts (rules 2–7 take them first). The worst a fooled judge can do is hold a finish, which still shows in the panel and the catch-up |
| Injection | Task text and chat text go in fenced blocks with a random tag. The system prompt says they are data and asks only "does this need the chat now?". No tools; the output is an enum. `why` and `line` are shown to Ben marked as the judge's words and are never typed into the chat as instructions |
| Fallback | Timeout (30 s), error, bad JSON or `claude` missing → wake (today's behaviour: never lose a result the chat asked for), logged `judge: unavailable`. Three failures in a row turn the judge off for an hour |
| Leans | Wake: the brief is done and the chat planned a next step ("then start B"); the result contradicts something said in the chat; Ben is mid-conversation about it. Hold: polish, reruns, progress, "done, nothing notable". Drop: only what a `notify` rule names |
| Cost cap | At most N calls an hour per channel (default 30); over the cap → hold |

### Layer 3 catch-up

| Way | When | Shape |
|---|---|---|
| Ride-along (default) | Ben's next message to the chat (UserPromptSubmit hook, exists) | `[channels] Held while you were away (3): logo — done, 2 variants; api-docs — done; tests — done, 1 flaky.` Uses no extra turn |
| Scheduled brief (opt-in) | A routine at the times Ben names ("9:00 and 17:00"), skipped when nothing is held | One turn: the chat gets the held list and says what matters in 3 lines |
| Age-out | Held more than 2 days with no message | Moves to the log only (the same age as a stale question card) |

## Event → outcome

| Event | Today | Gate | Why |
|---|---|---|---|
| Chat-started finish (`start`/`send`) | Notice, a chat turn | Judge: wake if it moves the chat's plan, else hold | The chat asked, but not every answer needs a turn now |
| Ben-typed rephrase in the task's view | Notice, a chat turn | Panel only (rule 4) | Ben was there |
| Ben-typed turn, chat registered (`--wake-on any`) | Wake | Wake (rule 2) | Someone asked to be told |
| Panel "Send message…" turn | Notice | Hold → catch-up (rule 5) | Ben's own ask; he'll review it |
| Question or hand-off, chat's turn | Notice + card | Same (rule 7) | The task is blocked on the chat |
| Question, Ben-typed turn | Notice + card | Card + dot (rule 4) | Ben is the one in that conversation |
| Permission prompt (Claude Code) | Card + ride-along | Same; no ride-along if Ben typed the turn (rule 3) | Only Ben can answer, from the card |
| Codex approval | Card (Allow/Deny) + ride-along | Same as a permission prompt | Same |
| Failure (job failed, process gone) | Notice like a finish | Wake (rule 6), shown as "failed" | Ben asked first: "tell me when anything fails" |
| Routine run typed into the chat | Typed in on schedule | Not gated | The schedule is Ben's own ask |
| A task a routine started finishes | Notice | Judge, with the routine's prompt as the brief; leans hold → brief | Routine reports are what a brief is for |
| Cloud task, any of the above | Same paths | Same rules; "who" comes from `last_event_at` vs `asked` | The list can't tell a question from a prompt: treat both as asking |
| Chat busy or Ben typing | Waits until idle | Same | Unchanged |

## Settings

A `notify` field on each channel, in plain words, one rule per line. It's set with `channels notify <channel> --set "<text>"`,
from the channel menu, or by the chat when Ben says it ("stop telling me about rephrasings"). It isn't kept in the
description, because the description is the chat's prompt and mixing them blurs both. A few words act as free presets
(layer 1); the judge reads the rest.

| Rule (example) | Read by | Effect |
|---|---|---|
| `all` | Rules | Today's behaviour: every chat-started finish wakes |
| `only when blocked or failed` | Rules | Finishes are held; questions and failures wake |
| `tell me when anything fails` | Rules (the default anyway) | Failures wake |
| `don't bother me with rephrasings or small edits` | Judge | Such finishes may be dropped (cites the rule) |
| `wake me when a PR is opened` | Judge | A finish whose result opens a PR wakes |
| `brief at 9:00 and 17:00` | Rules → routine | Adds the scheduled catch-up |
| `quiet 18:00–8:00` | Rules | Holds everything but failures and questions in those hours |

Default with no `notify`: rules plus the judge, ride-along catch-up, no brief.

**Trust: seeing what was held or dropped**

| Where | Shows |
|---|---|
| Panel | A "held" mark on the task row; the channel header counts held items; a held item offers **Tell chat** (the same button as a question card's) |
| `channels why <session>` | The task's last decisions: layer, outcome and reason (`rule 4: you typed it`, `judge: polish only`) |
| `gate.jsonl` in the store dir | One line per decision, so Ben can grep a week |
| Catch-up line | Ends "(+2 dropped by your rules)" so drops are never silent |
| Shadow mode | Phase 3 runs the judge for a week logging only; `channels why --would` compares it with what happened |

## Shared with agent-os (boris)

| Piece | Where |
|---|---|
| `gate.mjs`: the rules table, the judge's prompt builder and output check, the catch-up text | Here, vendored verbatim into agent-os (as `routines.mjs` and `schedule.mjs` are) |
| Running the judge (`claude -p`), storage, the presence signal, delivery | Each backend's own. `mcp/wake.mjs` calls the gate before `chatNoticeText`, and keeps its Duet path for sessions that aren't in a channel (Duet does its own deciding) |
| `asked` record and `--by` | Both backends' `send`/`start` (agent-os already has `--by` for routines) |

## Build phases

| Phase | Ships | Needs a model |
|---|---|---|
| 1 | Rules 1–8 and 11: finish the paused task's `asked` record (the `notice-stake` worktree) plus `--by user` for the panel; a `failed` kind kept separate from `done`; `gate.jsonl`; `channels why` | No |
| 2 | The `held` list, ride-along catch-up, the panel's held mark and Tell chat; presence (the mod writes `viewing` while a task's view is open) | No |
| 3 | The judge in shadow mode for a week, then live; the `notify` field and presets | Haiku |
| 4 | Scheduled brief through routines; `gate.mjs` vendored into agent-os | No |

## Open questions for Ben

1. Should a chat-started finish that the judge holds still ride along with your next chat message, or only show in the panel and the brief?
2. When the judge fails, should it wake (today's behaviour, noisier) or hold (quieter, risks a late result)?
3. Should a finish while you're watching the task skip the chat entirely, even when the chat started that turn?
