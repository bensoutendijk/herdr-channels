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
  // The task's claude.ai/code link, when it has Remote Control: the card offers Open on claude.ai.
  remote: string | null
  // A cloud task (claude.ai/code): its question can't be answered from the card, and Open opens it on claude.ai.
  cloud: boolean
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
