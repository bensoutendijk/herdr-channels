// Plain Herdr inside the channels window: which of Herdr's spaces the window is showing, or whether a channel is.
// The sidebar holds Herdr's own spaces list (the shipped "spaces" mod) under the channels, and the window turns into
// plain Herdr (Herdr's own tab bar, its Files and Changes panel) while Herdr shows a space that isn't the chats' own.
// A plain function, so the tests can run it without herdr.
//
// The chats live in spaces named "channels" (one per machine that holds chats: this computer's, or the backend's when
// the store is on another machine). Showing one of those is showing the selected channel.

export const isHold = (space, hold) => space?.name === hold;

// The Herdr space the window shows as plain Herdr (its id), or null while a channel is: decided on each tick from what
// Herdr shows. `state` is { space, seen, quiet }: that space, the shown space's id at the last tick, and until when (ms)
// a choice made here (a channel clicked) stands while Herdr catches up. Returns the next state.
//
// - It follows Herdr: when the shown space changes to one that isn't a chats space (clicked in Herdr's spaces list,
//   ⌃1-9, a new space), that space is shown; when it changes to a chats space, the channel is again.
// - A space that's gone (its last tab closed) gives the channel back, unless Herdr moved on to another space.
// - For a moment after a channel is clicked (`quiet`), Herdr's shown space may still be the old one: it isn't followed.
export function follow(state, spaces, hold, now) {
  const shown = (spaces ?? []).find((s) => s.active) ?? null;
  const id = shown?.id ?? null;
  let space = state?.space ?? null;
  const quiet = (state?.quiet ?? 0) > now;
  if (!quiet && id !== (state?.seen ?? null) && shown) space = isHold(shown, hold) ? null : shown.id;
  if (space && !(spaces ?? []).some((s) => s.id === space)) space = null;
  return { space, seen: quiet ? state?.seen ?? null : id, quiet: state?.quiet ?? 0 };
}
