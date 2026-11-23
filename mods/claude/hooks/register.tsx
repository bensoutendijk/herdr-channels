// channels-cards: the task cards above a herdr-channels chat's prompt.
//
// `channels chat` starts the chat's claude with this mod (--plugin-dir) and with CHANNELS_CHANNEL, the channel's id,
// CHANNELS_DIR, the store, and CHANNELS_ARGV, how to run the `channels` command. Every two seconds the mod reads
// the store's channels.json (only when it changed): the channel's inbox, which the listener beside the chat fills
// with its tasks' events. Each event is a card:
// - a question (the task ended its turn asking something): its question, an answer (a Select of the options it
//   listed, or an Input), Send, which runs `channels send <task> -`, and Open. One nobody answered in two days isn't
//   drawn (the listener drops it as well): a task that ended asking stays "blocked" in Claude Code's records;
// - a prompt (a permission prompt or another dialog in the task's own session): Open;
// - an approval (a Codex task asks to run a command, or change files, outside its sandbox): what it would run and why,
//   Allow and Deny, which run `channels approve <task> allow|deny`, and Open. The task's own view clears its prompt.
// Every card has Dismiss, which runs `channels card dismiss <task>`: the card goes, the task is left as it is.
// A command that fails says why on the card; Open that works says so in a toast (it acts in the Herdr window, where
// the task may already be showing, so without one a press that worked looked like nothing happened).
// A card of a task on another harness than Claude Code names it ("Codex asks").
// A finish has no card: it reaches the chat as a one-line notice (`channels notices`), and the chat takes a turn on it.
// A task with Remote Control on (its claude.ai/code link is in the inbox entry) also gets Open on claude.ai, which runs
// `channels link <task> --open`: the session opens in the browser, with macOS `open`.
// A cloud task (a Claude Code session at claude.ai/code) has no Answer: text sent to it waits behind its question. Its
// question card shows what it needs and one Open; Open runs `channels link <task> --open`, so it opens on claude.ai.
// No button starts a turn of the chat. Acting on a card takes
// it out of the inbox, so it doesn't ride along with the user's next message as well. What the user doesn't act on
// still rides along, unless the chat was told of it as a notice: the chat's UserPromptSubmit hook (`channels pending --hook`) takes it.
// The top card's buttons have hotkeys, and the card says which (KEYS): ctrl+x tab focuses the band, then s sends,
// o opens, d dismisses. A hotkey presses one Button of the mod (the later drawn wins), so only the top card has
// them; tab and enter reach the rest. Letters only: a bare digit answers a survey. On Claude Code's main-screen
// layout (not fullscreen) the band takes no clicks, so the keys are the way in there. Where neither reaches the band
// (a key binding takes ctrl+x first), /cards acts on the cards from the prompt (cardsCommand).
// Outside a channel's chat (no CHANNELS_CHANNEL) the mod draws nothing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, CardWork } from '../types'
import { OTHER, ago, cardsOf, lastLine, questionOf, stale } from './cards'

const cards = atom({ plugin: 'channels-cards', key: 'cards' } as const, [] as Card[])
const drafts = atom({ plugin: 'channels-cards', key: 'drafts' } as const, {} as Record<string, string>)
const work = atom({ plugin: 'channels-cards', key: 'work' } as const, [] as CardWork[])
// Cards acted on here, hidden until the store says so too (the command runs a moment before the next read).
const gone = atom({ plugin: 'channels-cards', key: 'gone' } as const, [] as string[])

const POLL_MS = 2000
const SHOWN = 4 // cards drawn at once; the rest are counted on one line

// The top card's hotkeys. Digits stay free for surveys.
const KEYS = { send: 's', open: 'o', remote: 'c', dismiss: 'd', allow: 'y', deny: 'n' } as const
type Key = keyof typeof KEYS

// Where the store is and how to run `channels`: set at session.start (a reload runs it again).
let storeFile: string | null = null
let channelId: string | null = null
let argv: string[] = ['channels']
let seenMtime = -1

async function poll($: EngineInterface) {
  if (!storeFile || !channelId) return
  let mtime = 0
  try {
    mtime = (await $.fs.stat(storeFile)).mtimeMs
  } catch {
    mtime = 0
  }
  if (mtime === seenMtime) return
  seenMtime = mtime
  let text = ''
  try {
    text = mtime ? await $.fs.read(storeFile) : ''
  } catch {
    return
  }
  const next = cardsOf(text, channelId)
  const now = JSON.stringify(next)
  await update($, cards, was => (JSON.stringify(was) === now ? was : next))
  // A card the store no longer holds is no longer hidden or worked on.
  const live = new Set(next.map(c => c.task))
  await update($, gone, was => (was.some(t => !live.has(t)) ? was.filter(t => live.has(t)) : was))
  await update($, work, was => (was.some(w => !live.has(w.task)) ? was.filter(w => live.has(w.task)) : was))
}

async function setWork($: EngineInterface, task: string, doing: string | null, error: string | null) {
  await update($, work, was => [...was.filter(w => w.task !== task), ...(doing || error ? [{ task, doing, error }] : [])])
}

// Runs `channels <args>` for a card: its output, or null after showing on the card why it failed.
async function channels($: EngineInterface, task: string, doing: string | null, args: string[], stdin?: string) {
  await setWork($, task, doing, null)
  try {
    const r = await $.process.run([...argv, ...args], { stdin, timeoutMs: 120_000 })
    if (r.exitCode !== 0) {
      await setWork($, task, null, lastLine(r.stderr || r.stdout) || `channels exited ${r.exitCode}`)
      return null
    }
    await setWork($, task, null, null)
    return r.stdout
  } catch (err) {
    await setWork($, task, null, String((err as Error)?.message ?? err))
    return null
  }
}

async function hide($: EngineInterface, task: string) {
  await update($, gone, was => (was.includes(task) ? was : [...was, task]))
}

async function send($: EngineInterface, card: Card, text: string) {
  const answer = text.trim()
  if (!answer || answer === OTHER) {
    await setWork($, card.task, null, 'Type an answer first.')
    return
  }
  if ((await channels($, card.task, 'Sending…', ['send', card.task, '-'], answer)) === null) return
  await hide($, card.task)
  $.ui.toast(`Sent to ${card.name}. It carries on.`)
}

async function approve($: EngineInterface, card: Card, decision: 'allow' | 'deny') {
  if ((await channels($, card.task, decision === 'allow' ? 'Allowing…' : 'Denying…', ['approve', card.task, decision])) === null) return
  await hide($, card.task)
  $.ui.toast(decision === 'allow' ? `Allowed. ${card.name} goes on.` : `Denied. ${card.name} goes on without it.`)
}

async function open($: EngineInterface, card: Card) {
  if ((await channels($, card.task, 'Opening…', ['open', card.task])) === null) return
  $.ui.toast(`${card.name} is in the tasks panel.`)
}

async function openRemote($: EngineInterface, card: Card) {
  if ((await channels($, card.task, 'Opening claude.ai…', ['link', card.task, '--open'])) === null) return
  $.ui.toast(`Opened ${card.name} on claude.ai.`)
}

// The card goes and the task is left as it is: `channels card dismiss` takes its inbox entry and its unread dot.
async function dismiss($: EngineInterface, card: Card) {
  if ((await channels($, card.task, 'Dismissing…', ['card', 'dismiss', card.task])) === null) return
  await hide($, card.task)
}

async function setDraft($: EngineInterface, task: string, value: string) {
  await update($, drafts, was => ({ ...was, [task]: value }))
}

// The cards drawn now, top first: the store's, less those acted on here and the stale questions.
async function shownCards($: EngineInterface) {
  const hidden = await read($, gone)
  const now = await $.clock.now()
  return (await read($, cards)).filter(c => !hidden.includes(c.task) && !stale(c, now))
}

// /cards: the cards without the band, for a terminal where it takes no click or focus. Typed in the prompt.
//   /cards                       lists them, numbered from the top
//   /cards send [n] <answer>     answers card n (1 when left out); an answer of a number picks that choice
//   /cards open|claude|dismiss|allow|deny [n]
const VERBS = ['send', 'open', 'claude', 'dismiss', 'allow', 'deny'] as const
type Verb = (typeof VERBS)[number]
const CARDS_HELP = '/cards lists the cards; /cards send [n] <answer>, /cards open [n], /cards dismiss [n] act on card n (the top one when left out); allow, deny and claude too.'

const what = (card: Card) =>
  card.cloud ? 'asks you (answer it on claude.ai)' : card.state === 'approval' ? `asks to ${card.command ? `run: ${card.command}` : 'change files'}` : card.state === 'prompt' ? `waits on a permission prompt: ${card.waiting ?? 'open it to answer'}` : `asks: ${asked(card)}`
// The question a card asks, in one line: its text's line that ends in "?", else what it waits on.
const asked = (card: Card) => {
  const lines = questionOf(card).split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => l.endsWith('?')) ?? card.waiting ?? lines[0] ?? 'open it to see'
}
const verbsOf = (card: Card): Verb[] =>
  card.cloud ? ['open', 'dismiss'] : card.state === 'approval' ? ['allow', 'deny', 'open', 'dismiss'] : card.state === 'prompt' ? ['open', ...(card.remote ? ['claude' as const] : []), 'dismiss'] : ['send', 'open', ...(card.remote ? ['claude' as const] : []), 'dismiss']

async function cardsCommand($: EngineInterface, args: string): Promise<string> {
  const all = await shownCards($)
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (!words.length || words[0] === 'list') {
    if (!all.length) return 'No task cards wait in this chat.'
    return all
      .map((c, i) => {
        const choices = c.options.length && c.state === 'question' && !c.cloud ? `\n   choices: ${c.options.map((o, j) => `${j + 1}. ${o}`).join('  ')}` : ''
        return `${i + 1}. ${c.name} ${what(c)}${choices}\n   /cards ${verbsOf(c).join('|')} ${i + 1}`
      })
      .join('\n')
  }
  const verb = words[0] as Verb
  if (!VERBS.includes(verb)) return `Unknown: ${words[0]}. ${CARDS_HELP}`
  // A number after the verb is the card's, except a lone one after send: that is the answer (a choice's number).
  const numbered = /^\d+$/.test(words[1] ?? '') && (verb !== 'send' || words.length > 2)
  const n = numbered ? Number(words[1]) : 1
  const rest = words.slice(numbered ? 2 : 1).join(' ')
  const card = all[n - 1]
  if (!card) return all.length ? `No card ${n}: ${all.length === 1 ? 'there is one' : `there are ${all.length}`}. /cards lists them.` : 'No task cards wait in this chat.'
  if (!verbsOf(card).includes(verb)) return `${card.name}'s card has no ${verb}: it takes /cards ${verbsOf(card).join('|')} ${n}.`
  if (verb === 'send') {
    if (!rest) return `Give the answer: /cards send ${n} <answer>${card.options.length ? ` (or the number of a choice: ${card.options.map((o, j) => `${j + 1}. ${o}`).join('  ')})` : ''}.`
    const pick = /^\d+$/.test(rest) ? card.options[Number(rest) - 1] : undefined
    await send($, card, pick ?? rest)
  } else if (verb === 'open') await (card.cloud ? openRemote($, card) : open($, card))
  else if (verb === 'claude') await openRemote($, card)
  else if (verb === 'dismiss') await dismiss($, card)
  else await approve($, card, verb)
  const failed = (await read($, work)).find(w => w.task === card.task)?.error
  if (failed) return `${card.name}: ${failed}`
  const sent = verb === 'send' ? ((/^\d+$/.test(rest) && card.options[Number(rest) - 1]) || rest) : ''
  return {
    send: `Sent "${sent}" to ${card.name}. It carries on.`,
    open: card.cloud ? `Opened ${card.name} on claude.ai.` : `${card.name} is in the tasks panel.`,
    claude: `Opened ${card.name} on claude.ai.`,
    dismiss: `Dismissed ${card.name}'s card. The task is left as it is.`,
    allow: `Allowed. ${card.name} goes on.`,
    deny: `Denied. ${card.name} goes on without it.`,
  }[verb]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const id = await $.env.get('CHANNELS_CHANNEL')
    const dir = await $.env.get('CHANNELS_DIR')
    if (!id || !dir) return started
    channelId = id
    storeFile = `${dir.replace(/\/+$/, '')}/channels.json`
    seenMtime = -1
    try {
      const raw = JSON.parse((await $.env.get('CHANNELS_ARGV')) ?? 'null')
      if (Array.isArray(raw) && raw.length && raw.every(a => typeof a === 'string')) argv = raw
    } catch {
      /* the command on PATH */
    }
    await poll($)
    $.clock.every(POLL_MS, () => poll($))
    await $.command.register({ name: 'cards', description: `The task cards, from the prompt: ${CARDS_HELP}`, argumentHint: '[send|open|dismiss|allow|deny|claude] [n] [answer]' })
    return started
  })

  on('command.run', { command: 'cards' }, async ($, e) => ({ text: await cardsCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const hidden = await read($, gone)
    const held = (await read($, cards)).filter(c => !hidden.includes(c.task))
    if (!held.length) return next(e)
    const now = await $.clock.now()
    const all = held.filter(c => !stale(c, now))
    if (!all.length) return next(e)
    const answers = await read($, drafts)
    const doing = await read($, work)
    const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)

    const status = (card: Card) => {
      const w = doing.find(x => x.task === card.task)
      if (w?.doing) return <Text dimColor>{w.doing}</Text>
      if (w?.error) return <Text color="error">{w.error}</Text>
      return null
    }

    // Only the top card's buttons get hotkeys (a hotkey presses one Button).
    const top = all[0]?.task
    const hot = (card: Card, k: Key) => (card.task === top ? { hotkey: KEYS[k] } : {})

    // The top card's line of keys, from the buttons it draws: "ctrl+x tab, then s send · o open · d dismiss".
    const keysLine = (card: Card, keys: [Key, string][], typing = false) =>
      card.task === top ? (
        <Text dimColor>
          {`Keys: ctrl+x tab, then ${typing ? 'type, enter sends; or tab, then ' : ''}`}
          {keys.map(([k, what]) => `${KEYS[k]} ${what}`).join(' · ')}
          {all.length > 1 ? ' · tab, enter for the cards below' : ''}
          {' · or type /cards'}
        </Text>
      ) : null

    const dismissButton = (card: Card) => (
      <Button key={`dismiss:${card.task}`} label="Dismiss" {...hot(card, 'dismiss')} onPress={() => dismiss($, card)} />
    )

    const remote = (card: Card) =>
      card.remote ? (
        <Button key={`remote:${card.task}`} label="Open on claude.ai" {...hot(card, 'remote')} onPress={() => openRemote($, card)} />
      ) : null
    const remoteKey = (card: Card): [Key, string][] => (card.remote ? [['remote', 'claude.ai']] : [])

    // A cloud task asks: what it needs, and Open (on claude.ai), where it is answered.
    const cloudQuestion = (card: Card) => (
      <Box key={`card:${card.task}`} flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} width={width}>
        <Text>
          <Text color="suggestion" bold>
            ?{' '}
          </Text>
          <Text bold>{card.name}</Text>
          <Text dimColor> ☁ asks you · {ago(card.at, now)}</Text>
        </Text>
        <Text maxLines={4}>{card.message ?? card.waiting ?? 'It asks you something: open it to see.'}</Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Answer it on claude.ai.</Text>
          <Button key={`open:${card.task}`} label="Open" variant="primary" {...hot(card, 'open')} onPress={() => openRemote($, card)} />
          {dismissButton(card)}
        </Box>
        {keysLine(card, [['open', 'open'], ['dismiss', 'dismiss']])}
        {status(card)}
      </Box>
    )

    const question = (card: Card) => {
      const options = card.options
      const draft = answers[card.task] ?? options[0] ?? ''
      const typing = !options.length || !options.includes(draft)
      return (
        <Box key={`card:${card.task}`} flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} width={width}>
          <Text>
            <Text color="suggestion" bold>
              ?{' '}
            </Text>
            <Text bold>{card.name}</Text>
            <Text dimColor> {card.harness ? `(${card.harness}) ` : ''}ended its turn asking you · {ago(card.at, now)}</Text>
          </Text>
          <Text maxLines={4}>{questionOf(card)}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {options.length ? (
              <Select
                key={`pick:${card.task}`}
                label="Answer"
                value={typing ? OTHER : draft}
                options={[...options.map(o => ({ value: o, label: o })), { value: OTHER, label: 'Something else…' }]}
                onSelect={value => setDraft($, card.task, value === OTHER ? '' : value)}
              />
            ) : null}
            {typing ? (
              <Input
                key={`answer:${card.task}`}
                label={options.length ? undefined : 'Answer'}
                placeholder="Type an answer…"
                value={draft}
                submitLabel="send"
                onInput={value => setDraft($, card.task, value)}
                onSubmit={value => send($, card, value)}
              />
            ) : null}
            <Button
              key={`send:${card.task}`}
              label="Send"
              variant="primary"
              {...hot(card, 'send')}
              {...(card.task === top && !typing ? { autoFocus: true as const } : {})}
              onPress={() => send($, card, draft)}
            />
            <Button key={`open:${card.task}`} label="Open" {...hot(card, 'open')} onPress={() => open($, card)} />
            {remote(card)}
            {dismissButton(card)}
          </Box>
          {keysLine(card, [['send', 'send'], ['open', 'open'], ...remoteKey(card), ['dismiss', 'dismiss']], !options.length)}
          {status(card)}
        </Box>
      )
    }

    const prompt = (card: Card) => (
      <Box key={`card:${card.task}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} width={width}>
        <Text>
          <Text color="warning" bold>
            !{' '}
          </Text>
          <Text bold>{card.name}</Text>
          <Text dimColor> waits on a permission prompt · {ago(card.at, now)}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor wrap="truncate-end">
            {card.waiting ?? 'A prompt'}: answer it in the task's view.
          </Text>
          <Button key={`open:${card.task}`} label="Open" variant="primary" {...hot(card, 'open')} onPress={() => open($, card)} />
          {remote(card)}
          {dismissButton(card)}
        </Box>
        {keysLine(card, [['open', 'open'], ...remoteKey(card), ['dismiss', 'dismiss']])}
        {status(card)}
      </Box>
    )

    // A Codex task asks to run something outside its sandbox: Allow or Deny answer it here.
    const approval = (card: Card) => (
      <Box key={`card:${card.task}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} width={width}>
        <Text>
          <Text color="warning" bold>
            !{' '}
          </Text>
          <Text bold>{card.name}</Text>
          <Text dimColor> {card.harness ?? 'It'} asks to {card.command ? 'run a command' : 'change files'} · {ago(card.at, now)}</Text>
        </Text>
        {card.command ? <Text maxLines={3}>$ {card.command}</Text> : null}
        {card.reason ? <Text dimColor maxLines={2}>{card.reason}</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Button key={`allow:${card.task}`} label="Allow" variant="primary" {...hot(card, 'allow')} onPress={() => approve($, card, 'allow')} />
          <Button key={`deny:${card.task}`} label="Deny" {...hot(card, 'deny')} onPress={() => approve($, card, 'deny')} />
          <Button key={`open:${card.task}`} label="Open" {...hot(card, 'open')} onPress={() => open($, card)} />
          {dismissButton(card)}
        </Box>
        {keysLine(card, [['allow', 'allow'], ['deny', 'deny'], ['open', 'open'], ['dismiss', 'dismiss']])}
        {status(card)}
      </Box>
    )

    const shown = all.slice(0, SHOWN)
    return (
      <Box flexDirection="column">
        {shown.map(card =>
          card.cloud ? cloudQuestion(card) : card.state === 'approval' ? approval(card) : card.state === 'prompt' ? prompt(card) : question(card),
        )}
        {all.length > SHOWN ? (
          <Text dimColor>
            {'  '}+{all.length - SHOWN} more: the tasks panel has them, and the chat hears of them.
          </Text>
        ) : null}
      </Box>
    )
  })
}
