import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cardsOf, questionOf, stale } from '../hooks/cards'

const BAND = {
  plugin: 'channels-cards',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const CH = 'ch_0123456789ab'
const Q = 'testmac/dddd0001-0000-4000-8000-000000000000'
const P = 'testmac/dddd0002-0000-4000-8000-000000000000'
const D = 'testmac/dddd0003-0000-4000-8000-000000000000'
const AT = '2026-11-19T10:00:00.000Z'
const NOW = Date.parse(AT) + 2 * 60_000

const question = (options: string[] = ['Teal', 'Coral', 'Ink']) => ({
  task: Q, name: 'Draw the logo', kind: 'needs', at: AT, text: '- task "Draw the logo" …',
  card: { state: 'question', waiting: 'Which colour?', message: 'Which colour should the logo be?', options },
})
const permission = {
  task: P, name: 'Migrate the database', kind: 'needs', at: AT, text: '…',
  card: { state: 'prompt', waiting: 'permission for Bash(psql -f migrate.sql)', message: null, options: [] },
}
const finished = { task: D, name: 'Write the release notes', kind: 'done', at: AT, text: '…', card: { state: 'done', message: 'Notes written.' } }

type Ran = { argv: readonly string[]; stdin?: string }

// The world under the mod: the chat's environment, a store on "disk" whose inbox the test sets, the clock, and
// `channels` itself, answered as the test says and recorded.
function world(on: On, inbox: unknown[], answer: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0 })) {
  mock.env(on, { CHANNELS_CHANNEL: CH, CHANNELS_DIR: '/store', CHANNELS_ARGV: JSON.stringify(['/bin/channels']) })
  const clock = mock.clock(on, { now: NOW })
  const disk = { text: JSON.stringify({ v: 2, channels: [{ id: 'ch_other', inbox: [question()] }, { id: CH, inbox }] }), mtime: 1 }
  on('fs.stat', () => ({ value: { kind: 'file', size: disk.text.length, mtimeMs: disk.mtime, isLink: false } as never }))
  on('fs.read', () => ({ value: disk.text }))
  const ran: Ran[] = []
  on('process.run', (_, e) => {
    ran.push({ argv: e.argv, stdin: e.init?.stdin })
    const r = answer(e.argv)
    return { value: { stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r } }
  })
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const setInbox = async (next: unknown[]) => {
    disk.text = JSON.stringify({ v: 2, channels: [{ id: CH, inbox: next }] })
    disk.mtime += 1
    await clock.advance(2000)
  }
  return { clock, ran, submitted, setInbox, toasts }
}

const start = ($: Engine, on: On) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('a question with options: pick one, Send runs channels send with it, and the chat takes no turn', async ($, on) => {
  const w = world(on, [question()])
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Draw the logo/ }))?.text).toContain('ended its turn asking you · 2m')
    expect(await ui.find({ type: 'Text', text: /Which colour should the logo be\?/ })).toBeDefined()
    expect(await ui.find({ key: `pick:${Q}` })).toBeDefined()
    expect(await ui.find({ key: `open:${Q}` })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.select({ key: `pick:${Q}`, value: 'Coral' })
  await ui.press({ key: `send:${Q}` })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'send', Q, '-'], stdin: 'Coral' }])
  expect(w.submitted).toEqual([])
  // Hidden at once, before the store catches up.
  expect(await ui.find({ key: `send:${Q}` })).toBeUndefined()
  await ui.unmount()
})

test('"Something else…" swaps the select for a field; Enter in it sends what was typed', async ($, on) => {
  const w = world(on, [question()])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.select({ key: `pick:${Q}`, value: '__something_else__' })
  expect(await ui.find({ key: `answer:${Q}` })).toBeDefined()
  await ui.input({ key: `answer:${Q}`, text: 'Forest green' })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'send', Q, '-'], stdin: 'Forest green' }])
  await ui.unmount()
})

test('a question with no options gets a field; an empty answer is refused on the card, a failed send says why', async ($, on) => {
  const w = world(on, [question([])], () => ({ exitCode: 1, stderr: 'testmac/dddd0001 is working. Send it after it finishes.\n' }))
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `pick:${Q}` })).toBeUndefined()
  await ui.press({ key: `send:${Q}` })
  expect(w.ran).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Type an answer first/ })).toBeDefined()
  await ui.input({ key: `answer:${Q}`, text: 'Bigger' })
  expect(w.ran).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /is working\. Send it after it finishes/ })).toBeDefined()
  expect(await ui.find({ key: `send:${Q}` })).toBeDefined()
  await ui.unmount()
})

test('a permission prompt offers Open only, which asks herdr to show the task', async ($, on) => {
  const w = world(on, [permission])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Migrate the database/ }))?.text).toContain('waits on a permission prompt')
  expect(await ui.find({ type: 'Text', text: /psql -f migrate\.sql\): answer it in the task's view/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual([`open:${P}`, `dismiss:${P}`])
  await ui.press({ key: `open:${P}` })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'open', P], stdin: undefined }])
  expect(w.toasts).toEqual(['Migrate the database is in the tasks panel.'])
  await ui.unmount()
})

test('a Codex approval shows what it would run and why; Allow and Deny answer it with channels approve', async ($, on) => {
  const approval = {
    task: P, name: 'Check the release notes', kind: 'needs', at: AT, text: '…', label: 'Codex', harness: 'codex',
    card: { state: 'approval', waiting: 'Run: curl -sI https://example.com', message: null, options: [], command: 'curl -sI https://example.com', reason: 'Check the link works' },
  }
  const w = world(on, [approval])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Check the release notes/ }))?.text).toContain('Codex asks to run a command')
  expect(await ui.find({ type: 'Text', text: /\$ curl -sI https:\/\/example\.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Check the link works/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual([`allow:${P}`, `deny:${P}`, `open:${P}`, `dismiss:${P}`])
  await ui.press({ key: `allow:${P}` })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'approve', P, 'allow'], stdin: undefined }])
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a Codex question names its harness', async ($, on) => {
  world(on, [{ ...question(), label: 'Codex', harness: 'codex' }])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Draw the logo/ }))?.text).toContain('(Codex) ended its turn asking you')
  await ui.unmount()
})

test('several stack, oldest first; past four the rest are counted; a finish draws no card; the store emptying clears the band', async ($, on) => {
  const later = (i: number) => new Date(Date.parse(AT) + i * 1000).toISOString()
  const more = [1, 2, 3, 4].map(i => ({ ...question(), task: `testmac/eeee000${i}-0000-4000-8000-000000000000`, name: `Task ${i}`, at: later(i) }))
  const w = world(on, [finished, ...more, permission])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
  expect(buttons.indexOf(`open:${P}`)).toBeLessThan(buttons.indexOf('send:testmac/eeee0001-0000-4000-8000-000000000000'))
  expect(buttons.some(b => `${b}`.endsWith(D))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /\+1 more/ })).toBeDefined()
  await w.setInbox([])
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('outside a channel chat the mod draws nothing', async ($, on) => {
  mock.env(on, {})
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the store read into cards: an older entry without a card, other channels left out, bad text gives none', () => {
  expect(cardsOf('not json', CH)).toEqual([])
  const old = { task: P, name: 'Old', kind: 'needs', at: AT, text: 'it shows a prompt; it waits on: permission' }
  const got = cardsOf(JSON.stringify({ channels: [{ id: CH, inbox: [finished, old] }, { id: 'x', inbox: [question()] }] }), CH)
  expect(got.map(c => [c.task, c.state])).toEqual([[P, 'prompt']], 'a finish from before notices is passed over')
  expect(got[0]?.options).toEqual([])
})

test('a question whose options are in the Select leaves their list out of its text', () => {
  const card = { task: Q, name: 'n', state: 'question', at: AT, since: AT, waiting: null, remote: null, cloud: false, options: ['Calm', 'Playful'], message: 'Which tone?\n\n1. **Calm**\n2. Playful\n\nI lean calm.' } as const
  expect(questionOf({ ...card, options: [...card.options] })).toBe('Which tone?\n\nI lean calm.')
  expect(questionOf({ ...card, options: [] })).toBe(card.message)
})

test('a task with a claude.ai link gets Open on claude.ai on its card, which runs channels link --open; one without gets none', async ($, on) => {
  const url = 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'
  const w = world(on, [{ ...question(), remote: url }, { ...permission, remote: url }])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `remote:${Q}` })).toBeDefined()
  expect(await ui.find({ key: `remote:${P}` })).toBeDefined()
  await ui.press({ key: `remote:${Q}` })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'link', Q, '--open'], stdin: undefined }])
  expect(w.submitted).toEqual([])
  expect(await ui.find({ key: `send:${Q}` })).toBeDefined()
  await ui.unmount()
})

test('a cloud task: its question card has no Answer, only Open, which opens it on claude.ai; its finish draws no card', async ($, on) => {
  const C = 'cloud/session_01AbCdEfGhIjKlMnOpQrStUv'
  const F = 'cloud/session_02ZyXwVuTsRqPoNmLkJiHgFe'
  const url = 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'
  const asks = { task: C, name: 'Fix the footer', kind: 'needs', at: AT, text: '…', cloud: true, remote: url, card: { state: 'question', waiting: 'Which page?', message: 'Should /press go, or point to the media kit?', options: [] } }
  const doneCloud = { task: F, name: 'Bump the deps', kind: 'done', at: AT, text: '…', cloud: true, remote: url, card: { state: 'done', message: 'Bumped 14 packages, PR #31 opened' } }
  expect(cardsOf(JSON.stringify({ channels: [{ id: CH, inbox: [asks, doneCloud] }] }), CH).map(c => c.cloud)).toEqual([true])
  const w = world(on, [asks, doneCloud])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `send:${C}` })).toBeUndefined()
  expect(await ui.find({ key: `answer:${C}` })).toBeUndefined()
  expect(await ui.find({ key: `pick:${C}` })).toBeUndefined()
  expect(await ui.find({ key: `remote:${C}` })).toBeUndefined()
  expect(await ui.find({ key: `remote:${F}` })).toBeUndefined()
  expect(await ui.find({ key: `open:${F}` })).toBeUndefined()
  await ui.press({ key: `open:${C}` })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'link', C, '--open'], stdin: undefined }])
  expect(w.submitted).toEqual([])
  await ui.unmount()
})

// The stuck card: a task ended its turn on a question days ago and stays "blocked" in Claude Code's records, so the
// listener's look never says it moved on. Its card can always be dismissed, and past two days it isn't drawn.
test('every card has Dismiss, which runs channels card dismiss and takes the card away; a failed one says why', async ($, on) => {
  let fails = false
  const w = world(on, [question(), permission], argv => (fails ? { exitCode: 1, stderr: 'No task testmac/dddd0002 in any channel.\n' } : { exitCode: 0 }))
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: `dismiss:${Q}` })
  expect(w.ran).toEqual([{ argv: ['/bin/channels', 'card', 'dismiss', Q], stdin: undefined }])
  expect(await ui.find({ key: `send:${Q}` })).toBeUndefined()
  expect(w.submitted).toEqual([])
  fails = true
  await ui.press({ key: `dismiss:${P}` })
  expect(await ui.find({ type: 'Text', text: /No task testmac\/dddd0002 in any channel\./ })).toBeDefined()
  expect(await ui.find({ key: `dismiss:${P}` })).toBeDefined()
  await ui.unmount()
})

test('a failed Open says why on the card; one that works says so in a toast', async ($, on) => {
  const w = world(on, [question()], () => ({ exitCode: 1, stderr: "The herdr window didn't take it: no window. Is Herdr open with the channels layout?\n" }))
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: `open:${Q}` })
  expect(await ui.find({ type: 'Text', text: /Is Herdr open with the channels layout\?/ })).toBeDefined()
  expect(w.toasts).toEqual([])
  await ui.unmount()
})

test('a question nobody answered in two days is not drawn; a prompt that old still is', async ($, on) => {
  const old = new Date(NOW - 3 * 86_400_000).toISOString()
  const w = world(on, [{ ...question(), at: old }, { ...permission, at: old }])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `send:${Q}` })).toBeUndefined()
  expect(await ui.find({ key: `open:${P}` })).toBeDefined()
  await w.setInbox([{ ...question(), at: new Date(NOW - 86_400_000).toISOString() }])
  expect(await ui.find({ key: `send:${Q}` })).toBeDefined()
  await ui.unmount()
  const [q] = cardsOf(JSON.stringify({ channels: [{ id: CH, inbox: [question()] }] }), CH)
  expect(stale(q!, NOW)).toBe(false)
  expect(stale(q!, NOW + 2 * 86_400_000)).toBe(true)
})

// The keyboard: on Claude Code's main screen the band takes no clicks, so every button of the top card has a letter
// (ctrl+x tab, then the letter), and the card says which. A hotkey presses one Button, so the cards below have none.
type Found = { key: string | undefined; props: Record<string, unknown> }
const hotkeys = async (ui: { findAll: (q: { type: string }) => Promise<Found[]> }) =>
  Object.fromEntries((await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.hotkey]))

test('the top card has a letter on every button and a line saying them; the cards below have none', async ($, on) => {
  const url = 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'
  world(on, [{ ...question(), remote: url }, { ...permission, at: new Date(Date.parse(AT) + 1000).toISOString() }])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hotkeys(ui)).toEqual({
    [`send:${Q}`]: 's', [`open:${Q}`]: 'o', [`remote:${Q}`]: 'c', [`dismiss:${Q}`]: 'd',
    [`open:${P}`]: undefined, [`dismiss:${P}`]: undefined,
  })
  const keys = await ui.findAll({ type: 'Text', text: /^Keys:/ })
  expect(keys.map(k => k.text)).toEqual(['Keys: ctrl+x tab, then s send · o open · c claude.ai · d dismiss · tab, enter for the cards below · or type /cards'])
  // ctrl+x tab lands on Send, not on the Select (an open Select takes every key, the letters too).
  expect((await ui.find({ key: `send:${Q}` }))?.props.autoFocus).toBe(true)
  expect((await ui.find({ key: `open:${P}` }))?.props.autoFocus).toBeUndefined()
  // Digits stay free: a bare digit answers a survey.
  expect(Object.values(await hotkeys(ui)).some(k => typeof k === 'string' && /\d/.test(k))).toBe(false)
  await ui.unmount()
})

test('the letters follow the top card: a prompt, an approval, a question to type, a cloud question', async ($, on) => {
  const approval = {
    task: P, name: 'Check the release notes', kind: 'needs', at: AT, text: '…', harness: 'codex',
    card: { state: 'approval', waiting: 'Run: ls', message: null, options: [], command: 'ls', reason: null },
  }
  const C = 'cloud/session_01AbCdEfGhIjKlMnOpQrStUv'
  const url = 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'
  const cloud = { task: C, name: 'Fix the footer', kind: 'needs', at: AT, text: '…', cloud: true, remote: url, card: { state: 'question', waiting: 'Which page?', message: 'Which page?', options: [] } }
  const w = world(on, [permission])
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = async () => (await ui.find({ type: 'Text', text: /^Keys:/ }))?.text
  expect(await hotkeys(ui)).toEqual({ [`open:${P}`]: 'o', [`dismiss:${P}`]: 'd' })
  expect(await line()).toBe('Keys: ctrl+x tab, then o open · d dismiss · or type /cards')
  await w.setInbox([approval])
  expect(await hotkeys(ui)).toEqual({ [`allow:${P}`]: 'y', [`deny:${P}`]: 'n', [`open:${P}`]: 'o', [`dismiss:${P}`]: 'd' })
  expect(await line()).toBe('Keys: ctrl+x tab, then y allow · n deny · o open · d dismiss · or type /cards')
  await w.setInbox([question([])])
  expect(await line()).toBe('Keys: ctrl+x tab, then type, enter sends; or tab, then s send · o open · d dismiss · or type /cards')
  await w.setInbox([cloud])
  expect(await hotkeys(ui)).toEqual({ [`open:${C}`]: 'o', [`dismiss:${C}`]: 'd' })
  expect(await line()).toBe('Keys: ctrl+x tab, then o open · d dismiss · or type /cards')
  await ui.unmount()
})

// /cards: the cards from the prompt, for a terminal where the band takes no click and no focus.
test('/cards lists the cards by number and acts on one from the prompt, with no turn of the chat', async ($, on) => {
  const w = world(on, [question(), { ...permission, at: new Date(Date.parse(AT) + 1000).toISOString() }])
  await start($, on)
  const run = async (args: string) => ((await $.command.run({ command: 'cards', args })) as { text?: string })?.text
  expect(await run('')).toBe(
    [
      '1. Draw the logo asks: Which colour should the logo be?',
      '   choices: 1. Teal  2. Coral  3. Ink',
      '   /cards send|open|dismiss 1',
      '2. Migrate the database waits on a permission prompt: permission for Bash(psql -f migrate.sql)',
      '   /cards open|dismiss 2',
    ].join('\n'),
  )
  // A lone number after send is a choice of the top card.
  expect(await run('send 2')).toBe('Sent "Coral" to Draw the logo. It carries on.')
  expect(w.ran.at(-1)).toEqual({ argv: ['/bin/channels', 'send', Q, '-'], stdin: 'Coral' })
  // Sent, so it's gone from the list: the prompt card is now 1.
  expect(await run('send 1 Forest green')).toBe("Migrate the database's card has no send: it takes /cards open|dismiss 1.")
  expect(await run('open')).toBe('Migrate the database is in the tasks panel.')
  expect(w.ran.at(-1)).toEqual({ argv: ['/bin/channels', 'open', P], stdin: undefined })
  expect(await run('dismiss 1')).toBe("Dismissed Migrate the database's card. The task is left as it is.")
  expect(await run('')).toBe('No task cards wait in this chat.')
  expect(await run('dismiss 3')).toBe('No task cards wait in this chat.')
  expect(await run('wave')).toMatch(/^Unknown: wave\. \/cards lists the cards/)
  expect(w.submitted).toEqual([])
})

test('/cards says why an action failed, and asks for an answer it was not given', async ($, on) => {
  world(on, [question([]), permission], () => ({ exitCode: 1, stderr: 'testmac/dddd0001 is working. Send it after it finishes.\n' }))
  await start($, on)
  const run = async (args: string) => ((await $.command.run({ command: 'cards', args })) as { text?: string })?.text
  expect(await run('send')).toBe('Give the answer: /cards send 1 <answer>.')
  expect(await run('send 1 Bigger')).toBe('Draw the logo: testmac/dddd0001 is working. Send it after it finishes.')
  expect(await run('dismiss 5')).toBe('No card 5: there are 2. /cards lists them.')
})
