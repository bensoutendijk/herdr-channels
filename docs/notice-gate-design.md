# Notice gate: when a task wakes its chat

A task event wakes the chat only when the chat asked for that turn and it failed, asks something, or (by a judge's
call) moves the chat's plan. Everything else shows in the tasks panel only, and is never told to the chat later.
It all happens on its own. Built in `bin/gate.mjs` (shared, pure) and the listener in `bin/channels.mjs`.

## Decisions

| Question | Decided |
|---|---|
| What happens to a finish that doesn't need the chat | Nothing: the panel shows it, the chat isn't told. No held list, no brief, no Tell chat |
| Judge fails or times out | Skip |
| The chat's turn ends while you have the task open | Panel only |
| Judge model | Sonnet (`CHANNELS_JUDGE_MODEL` to change) |
| Shadow week | Skipped: live from the start |

## How others decide

| Product | Interrupt when | Batch / drop | User control |
|---|---|---|---|
| Claude Duet | Something needs you: a task finished or needs review; anything irreversible waits for your OK | Checks accounts every few hours; a daily morning brief covers the rest | Plain words: what you want to hear about, and how often |
| GitHub | Every event whose *reason* is yours: `mention`, `review_requested`, `assign`, `author`, `ci_activity` (a run *you* triggered), `state_change` | Watching (`subscribed`) goes to the inbox, not push | Routes by reason; per-thread unsubscribe; per-repo watch level |
| Slack | DMs, @mentions and keywords; VIPs on mobile | Everything else is an unread badge only | Everything or mentions only, per-channel overrides, keywords, schedule |
| Linear | Only issues you're subscribed to; urgent or blocking status changes | Everything lands in the Inbox; email digests, skipped if already read | Per channel × per event type; snooze |
| iOS | Time Sensitive and allowed people or apps break through a Focus | Scheduled Summary; everything stays in Notification Center | Allow and silence lists that override the model |
| Claude Code background agents | A finished subagent reports to the session that started it, in a later turn | One report per finish | Wait vs. background, stop, resume |

**What they share:** the interrupt follows *whose* it is, plus *urgency*. Where a model rates importance, people's
explicit lists override it.

## The gate

| Layer | Decides | Signals | Cost |
|---|---|---|---|
| 0. Dedupe (as before) | Drop repeats | `told` mark, event key | Free |
| 1. Rules (`decide`) | Most events: wake, quiet, card, ride-along. Sends the rest to the judge | Who started the turn (`whoseTurn`: the `asked` record from `start`/`send`, `panel` from `send --by user`); registration; kind; failed; the task open in the panel (`viewing.json`); `notify` presets; quiet hours | Free |
| 2. Judge | Ordinary finishes of the chat's turns: wake or skip | The ask's text, the report (2k chars), the chat's last 6 messages, the channel's `notify` lines | `claude -p --model sonnet`: a few seconds, ~$0.006 a call (measured). Max 30 calls/hour/channel |

### Rules, in order (first match wins)

| # | If | Then |
|---|---|---|
| 1 | A registration matches | Wake |
| 2 | Permission prompt or Codex approval | Card; rides along only in the chat's turn |
| 3 | You typed the turn (no ask before its end) | Quiet |
| 4 | You had the task open when it ended | Quiet |
| 5 | Sent from the panel (`--by user`) | Quiet |
| 6 | The chat's turn failed | Wake |
| 7 | The chat's turn ended asking | Wake, with its card |
| 8 | Quiet hours | Quiet |
| 9 | `only when blocked or failed` | Quiet |
| 10 | `all` | Wake |
| 11 | The judge is resting or over its cap | Quiet |
| 12 | Otherwise | Judge |

### Judge

| Aspect | As built |
|---|---|
| Runs | `claude -p --model sonnet --output-format json --json-schema … --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --system-prompt …`, on the user's sign-in, in an empty folder. Not `--bare`: that skips the keychain sign-in |
| Async | The listener queues the finish on the channel's `judging` list, starts the call without waiting, and applies the answer when it comes. A newer event of the task replaces it |
| Output | `{do: wake/skip, why}`, from `structured_output`, checked again (`readVerdict`) |
| Injection | Every text sits in a `<data-RANDOM>` block nothing inside can close; the system prompt says it's data. No tools; the answer is one of two choices |
| Failure | Skip, logged. Three failures in a row: the judge rests an hour. `CHANNELS_JUDGE=off` turns it off |

## Event → outcome

| Event | Before | Now |
|---|---|---|
| Chat-started finish | Notice, a chat turn | The judge: notice, or panel only |
| Rephrase you typed in the task's view | Notice, a chat turn | Panel only |
| A turn you typed, with the chat registered | Wake | Wake |
| A turn sent from the panel | Notice | Panel only |
| A chat-started turn ending while you watch the task | Notice | Panel only |
| A question or hand-off in the chat's turn | Notice and card | Same |
| A question in your own turn | Notice and card | Card and dot only |
| Permission prompt or Codex approval | Card and ride-along | Same; card only in your own turn |
| A failure in the chat's turn | Notice ("finished") | Notice ("failed"), no judge |
| A routine run typed into the chat | Typed in | Not gated |
| Cloud task | Same paths | Same rules; who started it comes from `last_event_at` vs the ask |

## Settings (optional)

The channel's `notify` text: plain words, one rule per line. Set it from the channel menu's **Notifications**,
with `channels notify <channel> --set -`, or by telling the chat.

| Rule | Read by | Effect |
|---|---|---|
| `all` | Rules | Every chat-started finish wakes (no judge) |
| `only when blocked or failed` | Rules | Only failures and questions wake |
| `quiet 18:00-8:00` | Rules | Only failures and questions wake in those hours |
| `don't bother me with rephrasings` | Judge | Skips those |
| `wake me when a PR is opened` | Judge | Wakes on those |

`channels why <session>` and `gate.jsonl` say why an event did or didn't reach the chat.

## Shared with the hub backend

`bin/gate.mjs` touches no file, process or clock, like `routines.mjs`. The hub's channels command copies the
released file verbatim and calls `decide` before it tells a chat, with its own storage, judge runner and "who
started the turn" record.
