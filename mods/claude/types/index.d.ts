// A card: one event of the channel's tasks waiting in the store's inbox, as the cards mod draws it.
export type CardState = 'question' | 'prompt' | 'done'
export type Card = {
  task: string
  name: string
  state: CardState
  at: string
  waiting: string | null
  message: string | null
  options: string[]
}
// What is under way for a card: a command running, or the last one's failure.
export type CardWork = { task: string; doing: string | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'channels-cards': {
      cards: Card[]
      drafts: Record<string, string>
      work: CardWork[]
      gone: string[]
    }
  }
}
