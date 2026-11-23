// The harness seam (docs/harnesses.md §2): every harness module has the same shape, a task without a `harness` is
// Claude Code's, and the Claude harness's look and row say what the listener and `list` said before there were
// harnesses, from Claude Code's own records in a fake home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HARNESS, HARNESSES, harnessId, harnessOf } from '../bin/harness/index.mjs';
import claude, { promptDraft, sessionState, stateOf, turnEnded } from '../bin/harness/claude.mjs';

const SHAPE = ['installed', 'start', 'scan', 'look', 'withLast', 'row', 'find', 'read', 'send', 'rename'];

test('every harness has the interface, and its caps say what it offers', () => {
  for (const [id, h] of Object.entries(HARNESSES)) {
    assert.equal(h.id, id);
    assert.equal(typeof h.label, 'string');
    for (const fn of SHAPE) assert.equal(typeof h[fn], 'function', `${id}.${fn}`);
    for (const cap of ['rename', 'remoteControl', 'cloud', 'approvals', 'open']) assert.equal(typeof h.caps[cap], 'boolean', `${id}.caps.${cap}`);
    assert.ok(['refuse', 'queue'].includes(h.caps.sendWhileWorking));
  }
  assert.equal(HARNESSES.claude.caps.sendWhileWorking, 'refuse');
  assert.equal(HARNESSES.claude.caps.copies, true);
});

test('a task with no harness is Claude Code\'s; one on a harness this command doesn\'t know has none', () => {
  assert.equal(DEFAULT_HARNESS, 'claude');
  assert.equal(harnessId({}), 'claude');
  assert.equal(harnessOf({ machine: 'studio', session_id: 'x' }), claude);
  assert.equal(harnessOf({ harness: 'claude' }), claude);
  assert.equal(harnessOf({ harness: 'someday' }), null);
});

function home() {
  const h = mkdtempSync(join(tmpdir(), 'harness-'));
  const job = (id, state) => {
    mkdirSync(join(h, '.claude', 'jobs', id), { recursive: true });
    writeFileSync(join(h, '.claude', 'jobs', id, 'state.json'), JSON.stringify(state));
    writeFileSync(join(h, '.claude', 'jobs', id, 'timeline.jsonl'), '{}\n{}\n{}\n');
  };
  job('j1', { sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', state: 'blocked', needs: 'Which colour?', name: 'Logo', nameSource: 'auto', updatedAt: '2026-11-22T10:00:00Z', output: { result: 'r' } });
  job('j2', { sessionId: 'bbbbbbbb-2222-4222-8222-222222222222', state: 'done', detail: 'Done', name: 'Docs', updatedAt: '2026-11-22T11:00:00Z' });
  const proj = join(h, '.claude', 'projects', 'p');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'bbbbbbbb-2222-4222-8222-222222222222.jsonl'), [
    { type: 'user', message: { content: 'Write the docs' }, origin: { kind: 'human' }, cwd: '/x', timestamp: 't1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Wrote README.md.' }] }, timestamp: 't2' },
  ].map((x) => JSON.stringify(x)).join('\n'));
  return h;
}

test('Claude\'s look gives the listener a Snap in channels\' words', async () => {
  const h = home();
  try {
    const sc = await claude.scan({ deps: { home: h } });
    const asks = claude.look(sc, { machine: 'studio', session_id: 'aaaaaaaa-1111-4111-8111-111111111111', job: 'j1' });
    assert.equal(asks.harness, 'claude');
    assert.deepEqual([asks.st.state, asks.kind, asks.prompt, asks.waiting, asks.needs, asks.result, asks.at], ['blocked', 'needs', false, 'Which colour?', 'Which colour?', 'r', '2026-11-22T10:00:00Z']);
    assert.deepEqual(asks.mark, { kind: 'needs', work: 3 });
    assert.equal(asks.agentName, 'Logo');
    const done = claude.look(sc, { machine: 'studio', session_id: 'bbbbbbbb-2222-4222-8222-222222222222', job: 'j2' });
    assert.equal(done.kind, 'done');
    claude.withLast(done, (t) => (t ? `fp:${t.length}` : null));
    assert.equal(done.last, 'Wrote README.md.');
    assert.equal(done.mark.last, 'fp:16');
    // A copy keeps the task's name over the one Claude Code gave it.
    assert.equal(claude.look(sc, { machine: 'studio', session_id: 'bbbbbbbb-2222-4222-8222-222222222222', job: 'j2', how: 'copied', name: 'Mine' }).kept, 'Mine');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('Claude\'s row names a task as `channels list` does', async () => {
  const h = home();
  try {
    const sc = await claude.scan({ deps: { home: h } });
    assert.deepEqual(claude.row(sc, { machine: 'studio', session_id: 'aaaaaaaa-1111-4111-8111-111111111111', job: 'j1', name: 'filed' }, { local: 'studio' }), { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Logo', remote_url: null });
    assert.equal(claude.row(sc, { machine: 'studio', session_id: 'cccccccc-3333-4333-8333-333333333333', job: null, name: 'kept' }, { local: 'studio' }).name, 'kept');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// Claude Code calls a session busy while a background subagent it started runs, its own turn over or not (issue #51):
// the transcript's turn_duration line, after the turn's last message, says the turn is over.
test('Claude\'s state tells a turn that is over, while background work runs, from one under way', () => {
  const h = mkdtempSync(join(tmpdir(), 'harness-'));
  try {
    const file = (name, entries) => { const f = join(h, `${name}.jsonl`); writeFileSync(f, entries.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')); return f; };
    const ask = { type: 'user', message: { content: 'Start the sleeper' }, origin: { kind: 'human' } };
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent' }] } };
    const result = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
    const said = { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'started the sleeper' }] } };
    const ended = { type: 'system', subtype: 'turn_duration', durationMs: 8007 };
    const sub = { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Bash' }] } };
    const over = file('over', [ask, call, result, said, ended, { type: 'system', subtype: 'stop_hook_summary' }, sub, '{"type":"assis']);
    const under = file('under', [ask, call, result]);
    const nextTurn = file('next', [ask, call, result, said, ended, { type: 'user', message: { content: 'And then?' }, origin: { kind: 'human' } }]);
    assert.equal(turnEnded(over), true);
    assert.equal(turnEnded(under), false);
    assert.equal(turnEnded(nextTurn), false);
    assert.equal(turnEnded(join(h, 'none.jsonl')), null);
    assert.equal(turnEnded(file('empty', [])), null);

    const live = { status: 'busy' };
    const job = { state: 'working', detail: 'Sleeper running', inFlight: 1 };
    assert.deepEqual(stateOf({ live, job, turnOver: true }), { state: 'waiting_on_job', doing: 'Its turn is over, but a background task it started is still running' });
    assert.equal(stateOf({ live, job: { ...job, inFlight: 2 }, turnOver: true }).doing, 'Its turn is over, but 2 background tasks it started are still running');
    assert.deepEqual(stateOf({ live, job, turnOver: false }), { state: 'working', doing: 'Sleeper running' });
    assert.deepEqual(stateOf({ live, job, turnOver: null }), { state: 'working', doing: 'Sleeper running' });
    assert.equal(stateOf({ live, job: { ...job, inFlight: 0 }, turnOver: true }).state, 'working');
    assert.equal(stateOf({ live: { status: 'shell' }, job }).state, 'waiting_on_job');
    assert.equal(stateOf({ live: { status: 'idle' }, job }).state, 'waiting_on_job');

    // sessionState reads the transcript only for a busy session with background work in flight.
    assert.equal(sessionState(h, 's1', { live, job: { ...job, transcript: over } }).state, 'waiting_on_job');
    assert.equal(sessionState(h, 's1', { live, job: { ...job, transcript: under } }).state, 'working');
    assert.equal(sessionState(h, 's1', { live, job: { ...job, inFlight: 0, transcript: over } }).state, 'working');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('promptDraft reads Claude Code\'s prompt off a screen', () => {
  assert.equal(promptDraft('x\n❯ From the user: hi\n⏺ 4\n----\n❯ \n----\n  ⏺ main'), '');
  assert.equal(promptDraft('----\n❯ half\n----'), 'half');
  assert.equal(promptDraft('no prompt here'), null);
});
