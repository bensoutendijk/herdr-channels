// Herdr's own spaces in the channels sidebar: which are listed, and which one the sidebar selects as Herdr's shown
// space changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groups, follow } from '../mods/channels/spaces.js';

const HOLD = 'channels';
const sp = (id, name, extra = {}) => ({ id, name, machine: null, active: false, tabs: [], ...extra });
const show = (list, id) => list.map((s) => ({ ...s, active: s.id === id }));

test("the chats' spaces aren't listed, on any machine", () => {
  const all = [sp('a', 'acme'), sp('h', HOLD), sp('boris/h', HOLD, { machine: 'boris' }), sp('boris/x', 'agent-os', { machine: 'boris' })];
  assert.deepEqual(groups(all, HOLD).map((g) => [g.machine, g.spaces.map((s) => s.id)]), [[null, ['a']], ['boris', ['boris/x']]]);
});

test('this computer first, then the other machines by name, each keeping Herdr\'s order', () => {
  const all = [sp('z/1', 'one', { machine: 'zed' }), sp('b', 'b'), sp('a/1', 'x', { machine: 'alpha' }), sp('a', 'a'), sp('a/2', 'y', { machine: 'alpha' })];
  assert.deepEqual(groups(all, HOLD).map((g) => [g.machine, g.spaces.map((s) => s.id)]),
    [[null, ['b', 'a']], ['alpha', ['a/1', 'a/2']], ['zed', ['z/1']]]);
});

test('no spaces, or only chats, gives no groups', () => {
  assert.deepEqual(groups([], HOLD), []);
  assert.deepEqual(groups(undefined, HOLD), []);
  assert.deepEqual(groups([sp('h', HOLD)], HOLD), []);
});

const base = [sp('h', HOLD), sp('a', 'acme'), sp('b', 'shell'), sp('boris/x', 'agent-os', { machine: 'boris' })];

test('the sidebar follows Herdr to a space that is not a chats space (⌃1-9, a new space)', () => {
  let s = follow({ space: null, seen: 'h' }, show(base, 'h'), HOLD, 0);
  assert.equal(s.space, null, 'the chat is shown: a channel is selected');
  s = follow(s, show(base, 'a'), HOLD, 1);
  assert.equal(s.space, 'a');
  s = follow(s, show(base, 'boris/x'), HOLD, 2);
  assert.equal(s.space, 'boris/x', 'another machine\'s space too');
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
