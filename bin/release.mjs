// Versions and updates: herdr-channels is released on GitHub (semantic-release tags vX.Y.Z on every merge to main and
// publishes a GitHub Release), and an installed Mac learns about a newer release from there.
//
// - The version: install.mjs reads it from the clone (`git describe`): "1.2.0" on a release tag, "1.2.0+3.gabc1234"
//   past one, with ".dirty" for changes not committed, and null in a clone without tags. It goes into build.json in
//   the store, beside the build id.
// - The check: GET https://api.github.com/repos/<repo>/releases/latest, unauthenticated, with a generic User-Agent
//   and nothing else (no version, no machine, no account). The answer is cached in the store (release.json); the
//   launchd tick asks again once it is CHECK_MS old, and `channels update --check` asks at once.
// - The update, only when asked (the sidebar's Update button, or `channels update`): the clone is fast-forwarded to
//   the release tag, and install.mjs runs again with this Mac's options as the last install recorded them
//   (install.json in the store). That install restarts the chats on the new build (see "updates" in channels.mjs).
//   A clone with changes not committed, or one that has gone its own way, is left alone, and the reason given.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_SLUG = 'bensoutendijk/herdr-channels';
export const LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
export const CHECK_MS = 4 * 3600_000; // how old a check may be before the tick asks again
export const RETRY_MS = 3600_000; // after a failed check
export const UPDATE_MS = 15 * 60_000; // an update still "running" after this is taken to have died
const TAG = /^v(\d+\.\d+\.\d+)$/;
const NOTES = new RegExp(`^https://github\\.com/${REPO_SLUG.replace('/', '\\/')}/releases/tag/v\\d+\\.\\d+\\.\\d+$`);

// This clone (bin/..).
export const CLONE = dirname(dirname(fileURLToPath(import.meta.url)));

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ---------- the version ----------

// `git describe --tags --long --dirty --match v*` → the version: "1.2.0", "1.2.0+3.gabc1234", "1.2.0+0.gabc1234.dirty".
export function versionOf(describe) {
  const m = /^v(\d+\.\d+\.\d+)-(\d+)-(g[0-9a-f]+)(-dirty)?$/.exec(`${describe ?? ''}`.trim());
  if (!m) return null;
  return m[2] === '0' && !m[4] ? m[1] : `${m[1]}+${m[2]}.${m[3]}${m[4] ? '.dirty' : ''}`;
}

export function cloneVersion(repo = CLONE, run = spawnSync) {
  const r = run('git', ['-C', repo, 'describe', '--tags', '--long', '--dirty', '--match', 'v[0-9]*.[0-9]*.[0-9]*'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? versionOf(r.stdout) : null;
}

// Version strings compared on their X.Y.Z (1.10.0 > 1.9.3); null when either isn't one.
export function compareVersions(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(`${a ?? ''}`);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(`${b ?? ''}`);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  return 0;
}

// ---------- the check ----------

const releaseFile = (dir) => join(dir, 'release.json'); // { checked_at, latest: { version, tag, url, published_at } | null, error }
const updateFile = (dir) => join(dir, 'update.json'); // { state: running | done | failed, to, message, at, pid }
const installFile = (dir) => join(dir, 'install.json'); // { repo, args, at }: what install.mjs was given, for an update

export const readRelease = (dir) => readJson(releaseFile(dir));
export const readUpdate = (dir) => readJson(updateFile(dir));
export const readInstall = (dir) => readJson(installFile(dir));
export const writeInstall = (dir, value) => writeAtomic(installFile(dir), `${JSON.stringify(value, null, 2)}\n`);
const writeUpdate = (dir, value) => writeAtomic(updateFile(dir), `${JSON.stringify({ ...value, at: new Date().toISOString() })}\n`);

// GitHub's answer for the latest release, as the parts we keep. Throws on anything else.
export function parseLatest(body) {
  const tag = `${body?.tag_name ?? ''}`;
  const m = TAG.exec(tag);
  if (!m) throw new Error(`the latest release has no vX.Y.Z tag (${tag || 'none'})`);
  return { version: m[1], tag, url: NOTES.test(`${body.html_url ?? ''}`) ? body.html_url : `https://github.com/${REPO_SLUG}/releases/tag/${tag}`, published_at: body.published_at ?? null };
}

export async function fetchLatest({ url = process.env.CHANNELS_RELEASES_URL || LATEST_URL, fetch = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'herdr-channels' }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) throw new Error('no release yet');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return parseLatest(await res.json());
}

// Asks GitHub when the last check is older than `maxAgeMs` (0: now), and caches the answer. Answers the cache.
export async function checkRelease({ dir, maxAgeMs = CHECK_MS, now = Date.now(), fetchLatest: look = fetchLatest } = {}) {
  const was = readRelease(dir);
  const age = was?.checked_at ? now - Date.parse(was.checked_at) : Infinity;
  if (age >= 0 && age < (was?.error ? Math.min(maxAgeMs, RETRY_MS) : maxAgeMs)) return was;
  let next;
  try { next = { checked_at: new Date(now).toISOString(), latest: await look(), error: null }; } catch (err) {
    next = { checked_at: new Date(now).toISOString(), latest: was?.latest ?? null, error: String(err?.message ?? err) };
  }
  writeAtomic(releaseFile(dir), `${JSON.stringify(next)}\n`);
  return next;
}

// What `channels list --json` says about releases (updates.release): the version installed, the latest release
// known, whether it is newer, and the last update's state. `current` null is an install from before versions.
export function releaseStatus({ dir, build, now = Date.now() }) {
  const cache = readRelease(dir);
  const latest = cache?.latest ?? null;
  const current = build?.version ?? null;
  let update = readUpdate(dir);
  if (update?.state === 'running' && !(now - Date.parse(update.at) < UPDATE_MS && alive(update.pid))) update = { ...update, state: 'failed', message: 'The update stopped before it finished.' };
  return {
    current,
    latest: latest?.version ?? null,
    tag: latest?.tag ?? null,
    url: latest?.url ?? null,
    available: Boolean(latest) && (current == null || compareVersions(current, latest.version) < 0),
    checked_at: cache?.checked_at ?? null,
    error: cache?.error ?? null,
    update: update ? { state: update.state, to: update.to ?? null, message: update.message ?? null, at: update.at ?? null } : null,
  };
}

function alive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// ---------- the update ----------

export class UpdateRefused extends Error {}

// Fast-forwards the clone to `tag` (fetched first), or refuses with why, in a line short enough for the sidebar's
// release row (`channels update` names the clone). Answers { from, to, already }.
export function fastForward({ repo = CLONE, tag, git = gitRunner(repo) }) {
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.code !== 0) throw new UpdateRefused(`${repo} isn't a git clone git can read: ${dirty.err || dirty.out}`);
  if (dirty.out.trim()) throw new UpdateRefused('The clone has changes not committed. Commit or drop them, then update again.');
  const fetched = git(['fetch', '--quiet', '--tags', '--force']);
  if (fetched.code !== 0) throw new UpdateRefused(`git fetch failed: ${(fetched.err || fetched.out).trim().split('\n').pop()}`);
  const target = git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]).out.trim();
  if (!target) throw new UpdateRefused(`The release tag ${tag} isn't in the clone's remote.`);
  const head = git(['rev-parse', 'HEAD']).out.trim();
  if (head === target) return { from: head, to: target, already: true };
  if (git(['merge-base', '--is-ancestor', 'HEAD', target]).code !== 0) {
    const ahead = git(['merge-base', '--is-ancestor', target, 'HEAD']).code === 0;
    throw new UpdateRefused(ahead
      ? `The clone is past ${tag} already: it has newer commits.`
      : `The clone has commits that aren't in ${tag}. Update it by hand: git pull, then node install.mjs.`);
  }
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim();
  const moved = branch ? git(['merge', '--ff-only', '--quiet', target]) : git(['checkout', '--quiet', '--detach', target]);
  if (moved.code !== 0) throw new UpdateRefused(`git couldn't move the clone to ${tag}: ${(moved.err || moved.out).trim().split('\n').pop()}`);
  return { from: head, to: target, already: false };
}

function gitRunner(repo) {
  return (args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? r.error?.message ?? '' };
  };
}

// install.mjs again, from the clone as it is now, with the options the last install recorded.
export function reinstall({ repo = CLONE, args, node = process.execPath, run = spawnSync }) {
  const r = run(node, [join(repo, 'install.mjs'), ...args, '--no-switch'], { encoding: 'utf8', timeout: 15 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`install.mjs failed: ${`${r.stderr || r.stdout || r.error?.message || `exit ${r.status}`}`.trim().split('\n').pop()}`);
  const chats = /^\s*chats\s+(.*)$/m.exec(r.stdout ?? '');
  return { summary: chats ? chats[1].trim() : null };
}

// The whole update, recording its state for the sidebar. Answers { to, from, already, summary } or throws.
export async function update({ dir, repo = CLONE, look = fetchLatest, ff = fastForward, install = reinstall } = {}) {
  const now = readUpdate(dir);
  if (now?.state === 'running' && now.pid !== process.pid && alive(now.pid) && Date.now() - Date.parse(now.at) < UPDATE_MS) throw new UpdateRefused('An update is running already.');
  const recorded = readInstall(dir);
  if (!Array.isArray(recorded?.args)) throw new UpdateRefused('This Mac\'s install is from before updates: run `node install.mjs` once in the clone, then update.');
  writeUpdate(dir, { state: 'running', to: null, pid: process.pid });
  try {
    const cache = await checkRelease({ dir, maxAgeMs: 0, fetchLatest: look });
    if (!cache.latest || cache.error) throw new UpdateRefused(`Couldn't reach GitHub Releases: ${cache.error ?? 'no release'}.`);
    const to = cache.latest.version;
    writeUpdate(dir, { state: 'running', to, pid: process.pid });
    const moved = ff({ repo, tag: cache.latest.tag });
    const done = install({ repo, args: recorded.args });
    const message = `${moved.already ? `Installed ${to} again` : `Updated to ${to}`}.${done.summary ? ` ${done.summary}` : ''}`;
    writeUpdate(dir, { state: 'done', to, message, pid: process.pid });
    return { to, from: moved.from, already: moved.already, summary: done.summary, message };
  } catch (err) {
    writeUpdate(dir, { state: 'failed', to: readUpdate(dir)?.to ?? null, message: String(err?.message ?? err), pid: process.pid });
    throw err;
  }
}

// The same in its own process, for the sidebar: it outlives the mod, which the install reloads.
export function updateInBackground({ dir, script, env = process.env }) {
  const now = readUpdate(dir);
  if (now?.state === 'running' && alive(now.pid) && Date.now() - Date.parse(now.at) < UPDATE_MS) return { started: false, why: 'An update is running already.' };
  const child = spawn(process.execPath, [script, 'update'], { detached: true, stdio: 'ignore', env });
  child.unref();
  writeUpdate(dir, { state: 'running', to: now?.to ?? null, pid: child.pid });
  return { started: true, pid: child.pid };
}
