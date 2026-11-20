// Plain Herdr inside the channels window: which Herdr space the window shows as Herdr's shown space changes, or whether
// a channel is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { follow } from '../mods/channels/spaces.js';

const HOLD = 'channels';
const sp = (id, name, extra = {}) => ({ id, name, machine: null, active: false, tabs: [], ...extra });
const show = (list, id) => list.map((s) => ({ ...s, active: s.id === id }));

const base = [sp('h', HOLD), sp('a', 'acme'), sp('b', 'shell'), sp('server/x', 'api', { machine: 'server' })];

test('the sidebar follows Herdr to a space that is not a chats space (⌃1-9, a new space)', () => {
  let s = follow({ space: null, seen: 'h' }, show(base, 'h'), HOLD, 0);
  assert.equal(s.space, null, 'the chat is shown: a channel is selected');
  s = follow(s, show(base, 'a'), HOLD, 1);
  assert.equal(s.space, 'a');
  s = follow(s, show(base, 'server/x'), HOLD, 2);
  assert.equal(s.space, 'server/x', 'another machine\'s space too');
  s = follow(s, show(base, 'h'), HOLD, 3);
  assert.equal(s.space, null, 'back to the chats space: the channel again');
});

test('opening on a space that is already shown selects it (after a visit to another layout)', () => {
  assert.equal(follow(undefined, show(base, 'a'), HOLD, 0).space, 'a');
  assert.equal(follow({}, show(base, 'h'), HOLD, 0).space, null);
});

test('a choice made here stands while Herdr catches up', () => {
  // A channel clicked while a space was shown: Herdr still shows the space for a moment.
  let s = { space: null, seen: 'a', quiet: 1000 };
  s = follow(s, show(base, 'a'), HOLD, 500);
  assert.equal(s.space, null, 'not pulled back to the space');
  assert.equal(s.seen, 'a', 'what Herdr showed before the click is kept');
  s = follow(s, show(base, 'h'), HOLD, 1500);
  assert.equal(s.space, null);
  // If Herdr never left the space (the chat could not be shown), the channel stays selected: nothing changed there.
  s = follow({ space: null, seen: 'a', quiet: 1000 }, show(base, 'a'), HOLD, 1500);
  assert.equal(s.space, null);
  // A space clicked: it is selected at once, and stays once Herdr shows it.
  s = follow({ space: 'b', seen: 'h', quiet: 1000 }, show(base, 'h'), HOLD, 500);
  assert.equal(s.space, 'b');
  s = follow(s, show(base, 'b'), HOLD, 1500);
  assert.equal(s.space, 'b');
});

test('a space that is gone gives the channel back, unless Herdr moved on to another space', () => {
  const without = base.filter((x) => x.id !== 'a');
  // Its last tab closed and Herdr showed the chats space: the channel.
  assert.equal(follow({ space: 'a', seen: 'a' }, show(without, 'h'), HOLD, 0).space, null);
  // Herdr showed another space: that one.
  assert.equal(follow({ space: 'a', seen: 'a' }, show(without, 'b'), HOLD, 0).space, 'b');
  // Nothing shown at all: the channel.
  assert.equal(follow({ space: 'a', seen: 'a' }, without, HOLD, 0).space, null);
});

test('the state is plain data, as shared state keeps it', () => {
  const s = follow({ space: null, seen: 'h', quiet: 0 }, show(base, 'a'), HOLD, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { space: 'a', seen: 'a', quiet: 0 });
});

test("the layout carries Herdr's own pieces under their own names, beside the channels' own", async () => {
  const { readFileSync } = await import('node:fs');
  const layout = JSON.parse(readFileSync(new URL('../layouts/channels.json', import.meta.url), 'utf8'));
  const all = [];
  const walk = (n) => { all.push(n); (n.children ?? []).forEach(walk); };
  walk(layout);
  const byId = Object.fromEntries(all.map((n) => [n.id, n]));
  // Herdr's spaces list under the channels, its tab bar (hidden until a space is shown) and its Files/Changes panel,
  // with the ids Herdr's tab bar looks for.
  assert.equal(byId.spaces.content.mod, 'spaces');
  assert.equal(byId['space-tabs'].content.mod, 'tabs');
  assert.equal(byId['space-tabs'].hidden, true);
  assert.equal(byId.panel.hidden, true);
  assert.deepEqual(byId['panel-body'].children.map((c) => c.content.mod), ['files', 'changes']);
  // The tasks panel isn't "panel" (Herdr's tab bar shows and hides that one per space).
  assert.equal(byId['tasks-panel'].children[0].content.props.panel, true);
  // The sidebar: channels, Herdr's spaces, then the channels' footer.
  assert.deepEqual(byId.sidebar.children.map((c) => c.id), ['sidebar-head', 'sidebar-list', 'spaces', 'sidebar-foot']);
  assert.equal(byId['sidebar-foot'].content.props.foot, true);
});
