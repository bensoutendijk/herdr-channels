// What each channel's tasks panel showed last, so coming back to a channel shows it again. Plain functions, so
// the tests can run them without herdr (main.js keeps the map in shared state, which herdr saves to shared.json,
// so it outlasts a restart).
//
// The map is channel id -> null (the task list) or { id, job }: the task that was open. The job is kept as
// well as the id because a task's id can change after it is filed (a fresh session is filed by its job until
// its session id is known), while its job stays the same.

export const keyOf = (channel) => channel?.id ?? channel?.name ?? null;

// The map with this channel's entry set: a task, or null for the list.
export function remember(map, channel, task) {
  const key = keyOf(channel);
  if (key == null) return map ?? {};
  return { ...(map ?? {}), [key]: task ? { id: task.id, job: task.job ?? null } : null };
}

// The task to show again in this channel's panel, or null for the list: the one it showed last, if that task is
// still in the channel, not resolved, and `reachable` (a task on a machine this computer can't reach can't be
// opened). A channel never visited opens on the list.
export function restore(map, channel, reachable = () => true) {
  const want = (map ?? {})[keyOf(channel)];
  if (!want) return null;
  const task = (channel?.tasks ?? []).find((t) => t.id === want.id || (want.job && t.job === want.job)) ?? null;
  return task && !task.dismissed && reachable(task) ? task : null;
}
