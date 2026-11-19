// Plain functions the cards mod draws from, kept apart so the tests reach them without a store on disk.
import type { Card } from '../types'

type Entry = {
  task?: unknown
  name?: unknown
  kind?: unknown
  at?: unknown
  text?: unknown
  card?: { state?: unknown; waiting?: unknown; message?: unknown; options?: unknown } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

// The cards for one channel from the store's text (channels.json): its inbox, a card per task. An entry an older
// listener wrote has no `card`: what it is comes from its kind and its text.
export function cardsOf(storeText: string, channelId: string): Card[] {
  let store: { channels?: { id?: unknown; inbox?: unknown }[] }
  try {
    store = JSON.parse(storeText)
  } catch {
    return []
  }
  const channel = (store.channels ?? []).find(c => c?.id === channelId)
  const inbox = Array.isArray(channel?.inbox) ? (channel.inbox as Entry[]) : []
  const out: Card[] = []
  for (const e of inbox) {
    const task = str(e?.task)
    if (!task || (e.kind !== 'done' && e.kind !== 'needs')) continue
    const c = e.card ?? {}
    const text = str(e.text) ?? ''
    const state =
      c.state === 'question' || c.state === 'prompt' || c.state === 'done'
        ? c.state
        : e.kind === 'done'
          ? 'done'
          : /shows a prompt/.test(text)
            ? 'prompt'
            : 'question'
    const options = Array.isArray(c.options) ? c.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '') : []
    out.push({
      task,
      name: str(e.name) ?? task,
      state,
      at: str(e.at) ?? '',
      waiting: str(c.waiting),
      message: str(c.message),
      options: state === 'question' ? [...new Set(options)] : [],
    })
  }
  // What waits on the user first, then what finished; oldest first within each.
  const rank = (c: Card) => (c.state === 'done' ? 1 : 0)
  return out.sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at))
}

// "now", "4m", "2h", "3d": how long ago, short enough for a card's first line.
export function ago(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(at)) / 60000))
  if (!Number.isFinite(m)) return ''
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

// The last line of what a command printed, for a card to show when it failed.
export function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter(l => l.trim())
  return (lines[lines.length - 1] ?? '').trim()
}

export const OTHER = '__something_else__'
