// Versions and updates (bin/release.mjs): the version from git describe, the cached check against GitHub Releases,
// the fast-forward to a release tag with its refusals, the whole update, and the sidebar's release row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, cloneVersion, compareVersions, fastForward, parseLatest, readUpdate, releaseStatus, update, UpdateRefused, versionOf } from '../bin/release.mjs';
import { releaseRow, versionLabel } from '../mods/channels/updates.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'release-')));
const NOTES = (v) => `https://github.com/bensoutendijk/herdr-channels/releases/tag/v${v}`;
const latest = (v) => ({ version: v, tag: `v${v}`, url: NOTES(v), published_at: '2026-11-20T00:00:00Z' });

test('the version from git describe: a tag, past a tag, changes not committed, none', () => {
  assert.equal(versionOf('v1.2.0-0-gabc1234\n'), '1.2.0');
  assert.equal(versionOf('v1.2.0-3-gabc1234'), '1.2.0+3.gabc1234');
  assert.equal(versionOf('v1.2.0-0-gabc1234-dirty'), '1.2.0+0.gabc1234.dirty');
  assert.equal(versionOf('abc1234'), null);
  assert.equal(versionOf(''), null);
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('1.2.0+3.gabc1234', '1.2.0'), 0, 'past a tag is that release, not older');
  assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
});

test('GitHub\'s latest release: its vX.Y.Z tag and this repo\'s notes link, nothing else', () => {
  assert.deepEqual(parseLatest({ tag_name: 'v1.0.1', html_url: NOTES('1.0.1'), published_at: 'x', body: 'notes', author: { login: 'someone' } }), { version: '1.0.1', tag: 'v1.0.1', url: NOTES('1.0.1'), published_at: 'x' });
  assert.equal(parseLatest({ tag_name: 'v1.0.1', html_url: 'https://example.com/evil' }).url, NOTES('1.0.1'), 'a link elsewhere is replaced');
  assert.throws(() => parseLatest({ tag_name: 'nightly' }), /no vX.Y.Z tag/);
});

test('the check is cached: asked again only once it is old, sooner after a failure', async () => {
  const dir = tmp();
  let asked = 0;
  const look = async () => { asked++; return latest('1.0.1'); };
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  assert.equal((await checkRelease({ dir, now: t0, fetchLatest: look })).latest.version, '1.0.1');
  await checkRelease({ dir, now: t0 + 3600_000, fetchLatest: look });
  assert.equal(asked, 1, 'an hour later: the cache');
  await checkRelease({ dir, now: t0 + 5 * 3600_000, fetchLatest: look });
  assert.equal(asked, 2, 'five hours later: asked again');
  await checkRelease({ dir, now: t0 + 5 * 3600_000 + 1000, maxAgeMs: 0, fetchLatest: look });
  assert.equal(asked, 3, '--check asks at once');
  // A failure keeps the last answer, and is retried after an hour.
  const down = async () => { asked++; throw new Error('GitHub answered 503'); };
  const t1 = t0 + 10 * 3600_000;
  const failed = await checkRelease({ dir, now: t1, fetchLatest: down });
  assert.equal(failed.error, 'GitHub answered 503');
  assert.equal(failed.latest.version, '1.0.1');
  await checkRelease({ dir, now: t1 + 30 * 60_000, fetchLatest: down });
  assert.equal(asked, 4);
  await checkRelease({ dir, now: t1 + 61 * 60_000, fetchLatest: look });
  assert.equal(asked, 5);
  rmSync(dir, { recursive: true, force: true });
});

test('a release is available when it is newer than the installed version, or the version is unknown', async () => {
  const dir = tmp();
  await checkRelease({ dir, fetchLatest: async () => latest('1.0.1') });
  assert.equal(releaseStatus({ dir, build: { version: '1.0.0' } }).available, true);
  assert.equal(releaseStatus({ dir, build: { version: '1.0.1' } }).available, false);
  assert.equal(releaseStatus({ dir, build: { version: '1.0.1+2.gabc1234' } }).available, false);
  assert.equal(releaseStatus({ dir, build: { version: '1.1.0' } }).available, false);
  assert.equal(releaseStatus({ dir, build: { id: 'x' } }).available, true, 'an install from before versions');
  assert.equal(releaseStatus({ dir: tmp(), build: { version: '1.0.0' } }).available, false, 'never checked');
  rmSync(dir, { recursive: true, force: true });
});

// A remote with two releases, and a clone of it on the first.
function repos() {
  const root = tmp();
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.txt'), '1\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'feat: one');
  git(origin, 'tag', 'v1.0.0');
  const clone = join(root, 'clone');
  git(root, 'clone', '-q', origin, clone);
  writeFileSync(join(origin, 'a.txt'), '2\n');
  git(origin, 'commit', '-qam', 'fix: two');
  git(origin, 'tag', 'v1.0.1');
  return { root, origin, clone, git };
}

test('the clone fast-forwards to the release tag', () => {
  const { root, origin, clone, git } = repos();
  assert.equal(cloneVersion(clone), '1.0.0');
  const r = fastForward({ repo: clone, tag: 'v1.0.1' });
  assert.equal(r.already, false);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'v1.0.1'));
  assert.equal(git(clone, 'symbolic-ref', '--short', 'HEAD'), 'main', 'still on its branch');
  assert.equal(cloneVersion(clone), '1.0.1');
  assert.equal(fastForward({ repo: clone, tag: 'v1.0.1' }).already, true);
  rmSync(root, { recursive: true, force: true });
});

test('a clone with changes, with its own commits, or past the release is left alone, with why', () => {
  let { root, clone, git } = repos();
  writeFileSync(join(clone, 'a.txt'), 'mine\n');
  assert.throws(() => fastForward({ repo: clone, tag: 'v1.0.1' }), (e) => e instanceof UpdateRefused && /changes not committed/.test(e.message));
  assert.equal(readFileSync(join(clone, 'a.txt'), 'utf8'), 'mine\n');
  rmSync(root, { recursive: true, force: true });

  ({ root, clone, git } = repos());
  writeFileSync(join(clone, 'b.txt'), 'mine\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'my own');
  const head = git(clone, 'rev-parse', 'HEAD');
  assert.throws(() => fastForward({ repo: clone, tag: 'v1.0.1' }), /commits that aren't in v1.0.1/);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), head);
  rmSync(root, { recursive: true, force: true });

  ({ root, clone, git } = repos());
  git(clone, 'pull', '-q', '--ff-only');
  writeFileSync(join(clone, 'c.txt'), 'x\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'newer');
  assert.throws(() => fastForward({ repo: clone, tag: 'v1.0.1' }), /past v1.0.1 already/);
  assert.throws(() => fastForward({ repo: clone, tag: 'v9.9.9' }), /isn't in the clone's remote/);
  rmSync(root, { recursive: true, force: true });
});

test('update: checks now, moves the clone, installs with the recorded options, and records how it went', async () => {
  const { root, clone } = repos();
  const dir = join(root, 'store');
  const look = async () => latest('1.0.1');
  await assert.rejects(update({ dir, repo: clone, look }), /from before updates/);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ repo: clone, args: ['--store', dir, '--name', 'channels'] }));
  const calls = [];
  const r = await update({ dir, repo: clone, look, install: ({ repo, args }) => { calls.push({ repo, args, version: cloneVersion(repo) }); return { summary: 'Restarted #general.' }; } });
  assert.deepEqual(calls, [{ repo: clone, args: ['--store', dir, '--name', 'channels'], version: '1.0.1' }], 'the install runs from the release');
  assert.equal(r.message, 'Updated to 1.0.1. Restarted #general.');
  assert.deepEqual({ state: readUpdate(dir).state, to: readUpdate(dir).to }, { state: 'done', to: '1.0.1' });
  // A refusal is recorded for the sidebar too.
  writeFileSync(join(clone, 'a.txt'), 'mine\n');
  await assert.rejects(update({ dir, repo: clone, look: async () => latest('1.0.1') }), /changes not committed/);
  assert.equal(readUpdate(dir).state, 'failed');
  assert.match(releaseStatus({ dir, build: { version: '1.0.0' } }).update.message, /changes not committed/);
  rmSync(root, { recursive: true, force: true });
});

test('the sidebar\'s release row: offered, running, failed, and gone when current', () => {
  const release = { current: '1.0.0', latest: '1.0.1', url: NOTES('1.0.1'), available: true, update: null };
  assert.deepEqual(releaseRow(release), { state: 'offer', title: 'herdr-channels 1.0.1 available', detail: 'This Mac runs 1.0.0.', button: 'Update', notes: NOTES('1.0.1') });
  assert.equal(releaseRow({ ...release, current: null }).detail, 'This Mac runs a version from before releases.');
  assert.deepEqual(releaseRow({ ...release, update: { state: 'running', to: '1.0.1' } }), { state: 'running', title: 'Updating to 1.0.1…', detail: 'Installing. Chats restart once they are idle.', button: null, notes: null });
  assert.deepEqual(releaseRow({ ...release, update: { state: 'failed', to: '1.0.1', message: 'The clone has changes not committed.' } }),
    { state: 'failed', title: 'Update to 1.0.1 failed', detail: 'The clone has changes not committed.', button: 'Retry', notes: NOTES('1.0.1') });
  assert.equal(releaseRow({ ...release, update: { state: 'failed', to: '1.0.0', message: 'old' } }).state, 'offer', 'a failure for an older release is stale');
  assert.equal(releaseRow({ ...release, available: false, update: { state: 'done', to: '1.0.1' } }), null);
  assert.equal(releaseRow(null), null);
  assert.equal(versionLabel('1.0.1'), 'v1.0.1');
  assert.equal(versionLabel(null), null);
});
