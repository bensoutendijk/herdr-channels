// The mod's view of a channel's chat: whether it runs, and whether to start it again after it ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterEnd, chatAlive, lastLine, QUICK_MS, runsChat } from '../mods/channels/chats.js';
import { runsChat as cliRunsChat } from '../bin/channels.mjs';

const CHAT = ['/usr/bin/env', 'CHANNELS_DIR=/x', '/home/.local/bin/channels', 'chat', 'general'];

test('a chat is alive only while its terminal is live and runs the chat, not the shell herdr-core puts in its place', () => {
  assert.equal(chatAlive({ address: 't1', state: 'live', argv: CHAT }), true);
  assert.equal(chatAlive({ address: 't1', state: 'finished', argv: CHAT }), false, '/exit');
  assert.equal(chatAlive({ address: 't1', state: 'live', argv: ['/bin/zsh', '-l'] }), false, 'a lost terminal, given a shell');
  assert.equal(chatAlive(null), false, 'gone from terminals()');
  assert.equal(chatAlive({ address: 't1', state: 'live' }), false, 'no command known');
  // A chat started by an earlier version runs through sh -c; a renamed channel's chat still has its old name.
  assert.equal(runsChat(['sh', '-c', 'PATH="$0:$PATH" exec "$@"', '/x', '/home/.local/bin/channels', 'chat', 'old-name']), true);
  // The command line and the mod agree.
  for (const argv of [CHAT, ['/bin/zsh', '-l'], ['chat'], null]) assert.equal(runsChat(argv), cliRunsChat(argv), JSON.stringify(argv));
});

test('a chat that ran a while starts again on its own; one that stopped right after starting waits for a click', () => {
  const now = 1_000_000_000;
  const ended = (lived, extra = {}) => ({ state: 'finished', created_ms: now - lived - 500, finished_ms: now - 500, exit_code: 0, signal: null, ...extra });
  // /exit after a while: back on its own.
  assert.deepEqual(afterEnd(ended(10 * 60_000), { auto: true, channel: 'general', now }), { start: true });
  // A shell under the chat's address, or nothing herdr-core knows: `channels chat --bg` sorts it out.
  assert.deepEqual(afterEnd({ state: 'live', created_ms: now - 1000, argv: ['/bin/zsh', '-l'] }, { auto: true, channel: 'general', now }), { start: true });
  assert.deepEqual(afterEnd(null, { auto: true, channel: 'general', now }), { start: true });
  // Ended within seconds of starting: not again on its own, so it can't loop.
  const quick = afterEnd(ended(2000, { exit_code: 1 }), { auto: true, channel: 'general', now });
  assert.equal(quick.start, false);
  assert.equal(quick.message, "#general's chat stopped 2s after it started (exit 1).");
  assert.match(afterEnd(ended(1000, { exit_code: null, signal: 9 }), { auto: true, channel: 'general', now }).message, /\(signal 9\)/);
  assert.equal(afterEnd(ended(QUICK_MS - 1), { auto: true, channel: 'general', now }).start, false);
  assert.equal(afterEnd(ended(QUICK_MS), { auto: true, channel: 'general', now }).start, true);
  // A click on the channel always tries again.
  assert.deepEqual(afterEnd(ended(2000, { exit_code: 1 }), { auto: false, channel: 'general', now }), { start: true });
});

test('the last line a terminal printed, without colours, cut to fit', () => {
  assert.equal(lastLine('one\n\x1b[31mError: bad flag --x\x1b[0m\n\n  \n'), 'Error: bad flag --x');
  assert.equal(lastLine(''), '');
  assert.equal(lastLine(null), '');
  assert.equal(lastLine('x'.repeat(300)).length, 160);
});
