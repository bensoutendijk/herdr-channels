// Herdr's own spaces, in the channels sidebar: everything that isn't a channel's chat (a shell, a plain Claude Code
// session, a space on another machine) is reachable without leaving the channels window. Plain functions, so the
// tests can run them without herdr.
//
// The chats live in spaces named "channels" (one per machine that holds chats: this computer's, or the backend's
// when the store is on another machine); those are the channels' own and aren't listed. Every other space is, grouped
// by machine, this computer first, then the others by name, as Herdr's own sidebar orders them.

export const isHold = (space, hold) => space?.name === hold;

// [{ machine: null | name, spaces: [...] }], this computer first; a machine with no other spaces isn't listed.
export function groups(spaces, hold) {
  const by = new Map();
  for (const s of spaces ?? []) {
    if (isHold(s, hold)) continue;
    const m = s.machine ?? null;
    if (!by.has(m)) by.set(m, []);
    by.get(m).push(s);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : `${a}`.localeCompare(`${b}`)))
    .map(([machine, list]) => ({ machine, spaces: list }));
}

// Which Herdr space the sidebar has selected (its id), or null while a channel is: decided on each tick from what
// Herdr shows. `state` is { space, seen, quiet }: the selected space, the shown space's id at the last tick, and until
// when (ms) a choice made here stands while Herdr catches up. Returns the next state.
//
// - The sidebar follows Herdr: when the shown space changes to one that isn't a chats space (⌃1-9, Herdr's space keys,
//   a new space), that space is selected; when it changes to a chats space, the channel is again.
// - A space that's gone (its last tab closed) gives the channel back, unless Herdr moved on to another space.
// - For a moment after a click here (`quiet`), Herdr's shown space may still be the old one: it isn't followed then.
export function follow(state, spaces, hold, now) {
  const shown = (spaces ?? []).find((s) => s.active) ?? null;
  const id = shown?.id ?? null;
  let space = state?.space ?? null;
  const quiet = (state?.quiet ?? 0) > now;
  if (!quiet && id !== (state?.seen ?? null) && shown) space = isHold(shown, hold) ? null : shown.id;
  if (space && !(spaces ?? []).some((s) => s.id === space)) space = null;
  return { space, seen: quiet ? state?.seen ?? null : id, quiet: state?.quiet ?? 0 };
}
