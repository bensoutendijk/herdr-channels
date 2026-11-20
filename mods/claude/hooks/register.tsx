// channels-cards: the task cards above a herdr-channels chat's prompt.
//
// `channels chat` starts the chat's claude with this mod (--plugin-dir) and with CHANNELS_CHANNEL, the channel's id,
// CHANNELS_DIR, the store, and CHANNELS_ARGV, how to run the `channels` command. Every two seconds the mod reads
// the store's channels.json (only when it changed): the channel's inbox, which the listener beside the chat fills
// with its tasks' events. Each event is a card:
// - a question (the task ended its turn asking something): its question, an answer (a Select of the options it
//   listed, or an Input), Send, which runs `channels send <task> -`, and Open;
// - a prompt (a permission prompt or another dialog in the task's own session): Open only;
// - a finish: one quiet line, with Dismiss and Tell chat.
// A task with Remote Control on (its claude.ai/code link is in the inbox entry) also gets Open on claude.ai, which runs
// `channels link <task> --open`: the session opens in the browser, with macOS `open`.
// A cloud task (a Claude Code session at claude.ai/code) has no Answer: text sent to it waits behind its question. Its
// question card shows what it needs and one Open, and its finish card Dismiss, Tell chat and Open; Open runs
// `channels link <task> --open`, so it opens on claude.ai.
// No button starts a turn of the chat but Tell chat, which submits the task's report to it. Acting on a card takes
// it out of the inbox, so it doesn't ride along with the user's next message as well. What the user doesn't act on
// still rides along: the chat's UserPromptSubmit hook (`channels pending --hook`) takes it.
// Outside a channel's chat (no CHANNELS_CHANNEL) the mod draws nothing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, CardWork } from '../types'
import { OTHER, ago, cardsOf, lastLine, questionOf } from './cards'

const cards = atom({ plugin: 'channels-cards', key: 'cards' } as const, [] as Card[])
const drafts = atom({ plugin: 'channels-cards', key: 'drafts' } as const, {} as Record<string, string>)
const work = atom({ plugin: 'channels-cards', key: 'work' } as const, [] as CardWork[])
// Cards acted on here, hidden until the store says so too (the command runs a moment before the next read).
const gone = atom({ plugin: 'channels-cards', key: 'gone' } as const, [] as string[])

const POLL_MS = 2000
const SHOWN = 4 // cards drawn at once; the rest are counted on one line

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

async function open($: EngineInterface, card: Card) {
  await channels($, card.task, 'Opening…', ['open', card.task])
}

async function openRemote($: EngineInterface, card: Card) {
  await channels($, card.task, 'Opening claude.ai…', ['link', card.task, '--open'])
}

async function dismiss($: EngineInterface, card: Card) {
  await hide($, card.task)
  if ((await channels($, card.task, null, ['card', 'dismiss', card.task])) === null) {
    await update($, gone, was => was.filter(t => t !== card.task))
  }
}

// The one button that starts a turn: the task's report, whole, submitted to the chat.
async function tell($: EngineInterface, card: Card) {
  const text = await channels($, card.task, 'Telling the chat…', ['card', 'tell', card.task])
  if (text === null) return
  await hide($, card.task)
  await $.prompt.submit({ text: text.trim() })
}

async function setDraft($: EngineInterface, task: string, value: string) {
  await update($, drafts, was => ({ ...was, [task]: value }))
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
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const hidden = await read($, gone)
    const all = (await read($, cards)).filter(c => !hidden.includes(c.task))
    if (!all.length) return next(e)
    const answers = await read($, drafts)
    const doing = await read($, work)
    const now = await $.clock.now()
    const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)

    const status = (card: Card) => {
      const w = doing.find(x => x.task === card.task)
      if (w?.doing) return <Text dimColor>{w.doing}</Text>
      if (w?.error) return <Text color="error">{w.error}</Text>
      return null
    }

    const remote = (card: Card) =>
      card.remote ? <Button key={`remote:${card.task}`} label="Open on claude.ai" onPress={() => openRemote($, card)} /> : null

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
          <Button key={`open:${card.task}`} label="Open" variant="primary" onPress={() => openRemote($, card)} />
        </Box>
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
            <Text dimColor> asks · {ago(card.at, now)}</Text>
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
            <Button key={`send:${card.task}`} label="Send" variant="primary" onPress={() => send($, card, draft)} />
            <Button key={`open:${card.task}`} label="Open" onPress={() => open($, card)} />
            {remote(card)}
          </Box>
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
          <Button key={`open:${card.task}`} label="Open" variant="primary" onPress={() => open($, card)} />
          {remote(card)}
        </Box>
        {status(card)}
      </Box>
    )

    const done = (card: Card) => (
      <Box key={`card:${card.task}`} flexDirection="column" paddingX={1} width={width}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor wrap="truncate-end">
            <Text color="success">✓</Text> {card.name} {card.cloud ? '☁ ' : ''}finished · {ago(card.at, now)}
          </Text>
          <Button key={`dismiss:${card.task}`} label="Dismiss" onPress={() => dismiss($, card)} />
          <Button key={`tell:${card.task}`} label="Tell chat" onPress={() => tell($, card)} />
          {card.cloud ? <Button key={`open:${card.task}`} label="Open" onPress={() => openRemote($, card)} /> : remote(card)}
        </Box>
        {card.cloud && card.message ? (
          <Text dimColor maxLines={2}>
            {'  '}
            {card.message}
          </Text>
        ) : null}
        {status(card)}
      </Box>
    )

    const shown = all.slice(0, SHOWN)
    return (
      <Box flexDirection="column">
        {shown.map(card =>
          card.state === 'done' ? done(card) : card.cloud ? cloudQuestion(card) : card.state === 'prompt' ? prompt(card) : question(card),
        )}
        {all.length > SHOWN ? (
          <Text dimColor>
            {'  '}+{all.length - SHOWN} more: the tasks panel has them, and they ride along with your next message.
          </Text>
        ) : null}
      </Box>
    )
  })
}
