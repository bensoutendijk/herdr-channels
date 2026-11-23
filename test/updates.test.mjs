// The sidebar's refresh row: shown only while a chat is behind, with a Refresh button only when a click would do
// something now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshRow } from '../mods/channels/updates.js';

const chat = (channel, behind, state = 'idle', claude = '2.1.329') => ({ channel, behind, state, claude });
const base = { build: { id: 'b2', label: '3f2a1bc' }, claude: '2.1.330', asked: null };

test('no row while every chat is current, or no chat runs', () => {
  assert.equal(refreshRow(null), null);
  assert.equal(refreshRow({ ...base, chats: [] }), null);
  assert.equal(refreshRow({ ...base, chats: [chat('general', [])] }), null);
});

test('a newer Claude Code is offered with a Refresh button, busy chats or not', () => {
  assert.deepEqual(refreshRow({ ...base, chats: [chat('general', ['claude']), chat('design', ['claude'], 'busy'), chat('ops', [])] }),
    { offer: true, title: 'Claude Code 2.1.330', detail: '2 chats run 2.1.329' });
  assert.deepEqual(refreshRow({ ...base, chats: [chat('general', ['claude'], 'busy')] }),
    { offer: true, title: 'Claude Code 2.1.330', detail: '#general runs 2.1.329' });
});

test('once asked, chats mid-turn are only reported: they restart on their own', () => {
  assert.deepEqual(refreshRow({ ...base, asked: '2.1.330', chats: [chat('research', ['claude'], 'busy')] }),
    { offer: false, title: 'Updating', detail: '#research restarts when its turn ends.' });
  // After an install, the same: the build restarts chats without a click.
  assert.deepEqual(refreshRow({ ...base, chats: [chat('a', ['channels'], 'busy'), chat('b', ['channels'], 'waiting')] }),
    { offer: false, title: 'Updating', detail: '#a and #b restart when their turns end.' });
});

test('a chat behind the build that is idle (no timer, or before its tick) can be refreshed now', () => {
  assert.deepEqual(refreshRow({ ...base, chats: [chat('general', ['channels'])] }),
    { offer: true, title: 'herdr-channels updated', detail: '#general runs the version before' });
  assert.deepEqual(refreshRow({ ...base, chats: [chat('general', ['channels', 'claude'])] }),
    { offer: true, title: 'Updates installed', detail: 'Claude Code 2.1.330 and herdr-channels 3f2a1bc' });
});

test("a store on another machine's chats are behind on its own command, by the name it gives", () => {
  const row = refreshRow({ build: { id: 'b', label: 'abc1234', name: 'hub' }, claude: '2.1.5', asked: null, chats: [{ channel: 'general', behind: ['channels'], state: 'idle', claude: '2.1.5' }] });
  assert.deepEqual(row, { offer: true, title: 'hub updated', detail: '#general runs the version before' });
  const both = refreshRow({ build: { id: 'b', label: 'abc1234', name: 'hub' }, claude: '2.1.5', asked: null, chats: [{ channel: 'general', behind: ['channels', 'claude'], state: 'idle', claude: '2.1.4' }] });
  assert.deepEqual([both.title, both.detail], ['Updates installed', 'Claude Code 2.1.5 and hub abc1234']);
});

test('after Refresh all chats, the chats still to restart are reported until they have', () => {
  assert.deepEqual(refreshRow({ ...base, chats: [chat('general', ['restart'], 'busy'), chat('ops', [])] }),
    { offer: false, title: 'Refreshing', detail: '#general restarts when its turn ends.' });
  // Behind on an update too: that row, as before.
  assert.deepEqual(refreshRow({ ...base, asked: '2.1.330', chats: [chat('general', ['claude', 'restart'], 'busy')] }),
    { offer: false, title: 'Updating', detail: '#general restarts when its turn ends.' });
});
