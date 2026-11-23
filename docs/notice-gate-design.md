# Notice gate: when a task wakes its chat

A task event wakes the chat only when the chat asked for that turn and it failed, asks something, or (by a
judge's call) moves the chat's plan. Free rules settle most events; a Sonnet judge decides the rest; what waits
goes to a brief. Built in `bin/gate.mjs` (shared, pure) and the listener in `bin/channels.mjs`.

## Decisions

| Question | Decided |
|---|---|
| Does a held finish ride along with the next chat message? | No. Held events show in the panel, go out in the brief, or are sent with Tell chat |
| Judge fails or times out | Hold (not wake) |
| The chat's turn ends while you have the task open | Panel only: the chat skips it |
| Judge model | Sonnet (`CHANNELS_JUDGE_MODEL` to change) |
| Shadow week | Skipped: live from the start |

## How others decide

| Product | Interrupt when | Batch / drop | User control |
|---|---|---|---|
| Claude Duet | Something needs you: a task finished or needs review; anything irreversible waits for your OK | Checks accounts every few hours; a daily morning brief covers the rest. Its scoring isn't public and is "still being tuned" | Plain words: what you want to hear about, and how often |
| GitHub | Every event whose *reason* is yours: `mention`, `review_requested`, `assign`, `author`, `ci_activity` (a run *you* triggered), `state_change`, `approval_requested`, `agent_session_finished` | Watching (`subscribed`) goes to the inbox, not push. No digest; items expire after 3 months | Routes by reason (inbox, email, push); per-thread unsubscribe; per-repo watch level |
| Slack | DMs, @mentions and keywords ("Mentions & DMs" mode); VIPs on mobile | Everything else is an unread badge only. "Catch up" recaps: not confirmed in what we read | Everything or mentions only, per-channel overrides, keywords, notification schedule |
| Linear | Real time, only on issues you're subscribed to (created, assigned, @mentioned); urgent or blocking status changes | Everything lands in the Inbox. Email is immediate or a digest, delayed by urgency, and skipped if you've already read it | Per channel × per event type; snooze; a filtered Priority tab |
| iOS | Time Sensitive and allowed people or apps break through a Focus. "Reduce Interruptions" lets through what the model rates important | Scheduled Summary: a bundle at set times, most important first. Everything stays in Notification Center | Allow and silence lists that override the model; Focus schedules |
| Claude Code background agents | A finished subagent reports to the session that started it, as an automated event in a later turn (never mid-answer) | Nothing is batched; one report per finish | Wait vs. background, stop, resume |

**What they share:** the interrupt follows *whose* it is (GitHub's reasons, Linear's subscriptions, Claude Code's
"the one who started it"), plus *urgency* (Time Sensitive, blocking, approvals). The rest is batched into an inbox
or a summary, and almost nothing is truly dropped. Where a model rates importance (iOS, Duet), people's explicit
lists override it.

## The gate

| Layer | Decides | Signals | Cost |
|---|---|---|---|
| 0. Dedupe (as before) | Drop repeats | `told` mark, event key | Free |
| 1. Rules (`decide`) | Most events: wake, quiet, hold, card, ride-along. Sends the rest to the judge | Who started the turn (`whoseTurn`: the `asked` record from `start`/`send`, `panel` from `send --by user`); registration; kind (finish, asks, prompt); failed; the task open in the panel (`viewing.json`, said every minute); `notify` presets; quiet hours | Free |
| 2. Judge | Ordinary finishes of the chat's turns: wake, hold, drop | The ask's text, the report (2k chars), the chat's last 6 messages, the channel's `notify` lines, how many are held | `claude -p --model sonnet`: ~1.7 s, ~$0.006 a call (measured). Max 30 calls/hour/channel |
| 3. Held and brief | Where held events go | The channel's `held` list (2-day life), `dropped` count, brief times | Free; a brief is one chat turn |

### Rules, in order (first match wins)

| # | If | Then |
|---|---|---|
| 1 | A registration matches | Wake |
| 2 | Permission prompt or Codex approval | Card; rides along only in the chat's turn |
| 3 | You typed the turn (no ask before its end) | Quiet: panel only |
| 4 | You had the task open when it ended | Quiet |
| 5 | Sent from the panel (`--by user`) | Hold |
| 6 | The chat's turn failed | Wake |
| 7 | The chat's turn ended asking | Wake, with its card |
| 8 | Quiet hours | Hold |
| 9 | `only when blocked or failed` | Hold |
| 10 | `all` | Wake |
| 11 | The judge is resting or over its cap | Hold |
| 12 | Otherwise | Judge |

### Judge

| Aspect | As built |
|---|---|
| Runs | `claude -p --model sonnet --output-format json --json-schema … --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --system-prompt …`, on the user's sign-in, in an empty folder. Not `--bare`: that skips the keychain sign-in |
| Async | The listener queues the finish on the channel's `judging` list, starts the call without waiting, and applies the answer when it comes. A newer event of the task replaces it |
| Output | `{do: wake/hold/drop, why, line, rule}`, taken from `structured_output` and checked again (`readVerdict`) |
| Guards | A drop must cite one of the channel's rules by number, or it becomes a hold. Questions, failures and prompts never reach the judge |
| Injection | Every text sits in a `<data-RANDOM>` block that nothing inside can close; the system prompt says it's data. No tools; the answer is one of three choices |
| Failure | Hold, logged. Three failures in a row: the judge rests an hour (finishes are held without a call). `CHANNELS_JUDGE=off` turns it off |

## Event → outcome

| Event | Before | Now |
|---|---|---|
| Chat-started finish | Notice, a chat turn | The judge: notice, held, or dropped by a rule |
| Rephrase you typed in the task's view | Notice, a chat turn | Panel only |
| A turn you typed, with the chat registered | Wake | Wake |
| A turn sent from the panel | Notice | Held |
| A chat-started turn ending while you watch the task | Notice | Panel only |
| A question or hand-off in the chat's turn | Notice and card | Same |
| A question in your own turn | Notice and card | Card and dot only |
| Permission prompt or Codex approval | Card and ride-along | Same; card only in your own turn |
| A failure in the chat's turn | Notice ("finished") | Notice ("failed"), no judge |
| A routine run typed into the chat | Typed in | Not gated (you scheduled it) |
| A task the chat started from a routine finishes | Notice | Judge (the routine's ask is its brief) |
| Cloud task | Same paths | Same rules; who started it comes from `last_event_at` vs the ask |

## Settings

The channel's `notify` text: plain words, one rule per line. Set it from the channel menu's
**Notifications**, with `channels notify <channel> --set -`, or by telling the chat.

| Rule | Read by | Effect |
|---|---|---|
| `all` | Rules | Every chat-started finish wakes (no judge) |
| `only when blocked or failed` | Rules | Finishes are held |
| `brief at 9:00 and 17:00` | Rules | Held events reach the chat at those times as one notice (the minute tick) |
| `quiet 18:00-8:00` | Rules | Only failures and questions wake in those hours |
| `don't bother me with rephrasings` | Judge | May drop those (counted in the brief) |
| `wake me when a PR is opened` | Judge | Wakes on those |

## Seeing what was held or dropped

| Where | Shows |
|---|---|
| Panel | A "held" mark on the task (its tooltip says why); the task menu's **Tell chat** |
| `channels held <channel>` | Held events with why, those with the judge now, and the dropped count |
| `channels why <session>` | The gate's last decisions on the task: rule or judge, and why |
| `gate.jsonl` | One line per decision, beside the store |
| The brief | Ends with how many your rules dropped |

## Shared with the hub backend

`bin/gate.mjs` touches no file, process or clock, like `routines.mjs`. The hub's channels command copies it
verbatim and calls `decide` before it tells a chat, with its own storage, judge runner and "who started the
turn" record. Its other path, for sessions outside a channel, keeps deciding for itself.

## Open questions

1. Should a brief also go out when held events pile up (say 10), not only at set times?
2. Should Tell chat also be on the card above the chat's prompt, not only in the panel?
