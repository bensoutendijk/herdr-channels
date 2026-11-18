// What each channel's tasks panel showed last, and what coming back to the channel shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remember, restore } from '../mods/channels/panels.js';

const task = (id, extra = {}) => ({ id, machine: 'mac', session_id: id.split('/')[1], job: null, ...extra });
const a = { id: 'ch_a', name: 'alpha', tasks: [task('mac/s1', { job: 'j1' }), task('mac/s2')] };
const b = { id: 'ch_b', name: 'beta', tasks: [task('mac/s3')] };

test('a channel not visited yet opens on the list', () => {
  assert.equal(restore({}, a), null);
  assert.equal(restore(undefined, a), null);
  assert.equal(restore(remember({}, b, b.tasks[0]), a), null, "another channel's task doesn't count");
});

test('each channel gets back the task it showed last, independently of the others', () => {
  let map = remember({}, a, a.tasks[1]);
  map = remember(map, b, b.tasks[0]);
  assert.equal(restore(map, a), a.tasks[1]);
  assert.equal(restore(map, b), b.tasks[0]);
  // Another task opened in A replaces A's, and leaves B's.
  map = remember(map, a, a.tasks[0]);
  assert.equal(restore(map, a), a.tasks[0]);
  assert.equal(restore(map, b), b.tasks[0]);
  // The map is plain data, as shared state keeps it (and saves it across a restart).
  assert.deepEqual(JSON.parse(JSON.stringify(map)), { ch_a: { id: 'mac/s1', job: 'j1' }, ch_b: { id: 'mac/s3', job: null } });
});

test('going back to the list is remembered: the channel opens on the list next time', () => {
  const map = remember(remember({}, a, a.tasks[0]), a, null);
  assert.equal(restore(map, a), null);
  assert.deepEqual(map, { ch_a: null });
});

test('a task resolved, gone or out of reach since gives the list', () => {
  const map = remember(remember({}, a, a.tasks[0]), b, b.tasks[0]);
  const resolved = { ...a, tasks: [{ ...a.tasks[0], dismissed: true }, a.tasks[1]] };
  assert.equal(restore(map, resolved), null, 'resolved while away');
  assert.equal(restore(map, { ...b, tasks: [] }), null, 'no longer in the channel');
  assert.equal(restore(map, { ...b, tasks: undefined }), null);
  assert.equal(restore(map, b, () => false), null, 'on a machine this computer cannot reach');
});

test('a fresh session remembered before it was filed is found by its job', () => {
  const fresh = { id: 'pending/0f0e', job: 'jfresh' };
  const map = remember({}, a, fresh);
  const filed = { ...a, tasks: [...a.tasks, task('mac/job:jfresh', { job: 'jfresh' })] };
  assert.equal(restore(map, filed)?.id, 'mac/job:jfresh');
  assert.equal(restore(map, a), null, 'not filed yet: the list');
});

test('a channel without an id (an older store) is keyed by its name', () => {
  const old = { name: 'gamma', tasks: [task('mac/s9')] };
  assert.equal(restore(remember({}, old, old.tasks[0]), old), old.tasks[0]);
  assert.deepEqual(remember({ x: null }, null, a.tasks[0]), { x: null });
});
