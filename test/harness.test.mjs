// The harness seam (docs/harnesses.md §2): every harness module has the same shape, a task without a `harness` is
// Claude Code's, and the Claude harness's look and row say what the listener and `list` said before there were
// harnesses, from Claude Code's own records in a fake home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HARNESS, HARNESSES, harnessId, harnessOf } from '../bin/harness/index.mjs';
import claude from '../bin/harness/claude.mjs';

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
