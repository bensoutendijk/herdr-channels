// cloud.mjs: Claude Code cloud sessions (claude.ai/code, "Claude Code on the web"), for programs on this machine.
//
// Standalone on purpose: it imports nothing from the rest of herdr-channels, so another program can copy or import
// it as it is.
//
//   listCloudSessions(opts)      every cloud session on the account, with its state, summary and cost
//   startCloudSession(opts)      `claude --cloud "<brief>" -n <title>` under a pty: the new session's id and link
//   sendToCloudSession(opts)     `claude -p "<text>" --cloud <id>`: a message to a session
//   probeAttach(opts)            whether `claude --cloud <id>` can attach a terminal for this account, as it stands
//   cloudId(raw), cseId(raw), cloudUrl(raw)   a session_…, cse_… or claude.ai/code link as either id, or its link
//
// THE LIST RIDES ON CLAUDE CODE'S PRIVATE API. `GET https://api.anthropic.com/v1/code/sessions` is what Claude Code
// itself calls for its teleport picker and /list-agents. It isn't documented and can change without notice: every
// failure here is an error a caller is expected to survive ("state unknown"), never a crash. It is called with the
// claude.ai login Claude Code stores: the login Keychain item "Claude Code-credentials" on macOS, else
// ~/.claude/.credentials.json (CLAUDE_CONFIG_DIR moves it). The token is read fresh on every call, because Claude Code
// refreshes it, and it is never printed, logged, kept or put in an error. Start and send are Claude Code's own CLI.
// Nothing here sets or reads Claude Code's settings or rollout flags.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const API = 'https://api.anthropic.com';
const BETA = 'ccr-byoc-2025-07-29';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// A failure, with a kind a caller can act on: 'login' (no stored claude.ai login, or it can't be read), 'auth' (the
// API refused the token: usually it expired and Claude Code hasn't refreshed it yet, so wait and try again), 'http'
// (another HTTP status), 'network', 'format' (an answer this module doesn't understand). Its message never holds the
// token.
export class CloudError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CloudError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// ---------- ids and links ----------

const SUFFIX = /^[A-Za-z0-9]{8,64}$/;

// The suffix the two ids of a session share: the CLI prints session_<x>, the API lists cse_<x>.
function suffixOf(raw) {
  const text = `${raw ?? ''}`.trim();
  let m = /^(?:session|cse)_([A-Za-z0-9]+)$/.exec(text);
  if (!m) m = /^https:\/\/claude\.ai\/code\/(?:session|cse)_([A-Za-z0-9]+)(?:[/?#].*)?$/.exec(text);
  return m && SUFFIX.test(m[1]) ? m[1] : null;
}
export const cloudId = (raw) => { const s = suffixOf(raw); return s ? `session_${s}` : null; };
export const cseId = (raw) => { const s = suffixOf(raw); return s ? `cse_${s}` : null; };
export const cloudUrl = (raw) => { const s = suffixOf(raw); return s ? `https://claude.ai/code/session_${s}` : null; };

// ---------- the stored login ----------

function run(cmd, args, { timeout = 10_000, input, env, cwd } = {}) {
  return new Promise((done) => {
    let out = '';
    let err = '';
    let child;
    try { child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return done({ code: 127, out, err: e.message }); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ code: 127, out, err: `${err}${e.message}` }); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code: code ?? (signal ? 1 : 0), out, err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const configDir = (env, home) => env.CLAUDE_CONFIG_DIR || join(home, '.claude');

// The stored login's OAuth block ({ accessToken, expiresAt, scopes, … }), read now. `credentialsFile` reads that file
// only (tests, or a machine where the login lives elsewhere).
async function readLogin({ platform, env, home, credentialsFile, exec }) {
  const parse = (text) => {
    try { return JSON.parse(text)?.claudeAiOauth ?? null; } catch { return null; }
  };
  if (credentialsFile) {
    let text;
    try { text = readFileSync(credentialsFile, 'utf8'); } catch { throw new CloudError('login', `No claude.ai login in ${credentialsFile}.`); }
    const o = parse(text);
    if (!o?.accessToken) throw new CloudError('login', `${credentialsFile} holds no claude.ai login.`);
    return o;
  }
  if (platform === 'darwin') {
    const r = await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 15_000, env });
    const o = r.code === 0 ? parse(r.out.trim()) : null;
    if (o?.accessToken) return o;
  }
  const file = join(configDir(env, home), '.credentials.json');
  let text = null;
  try { text = readFileSync(file, 'utf8'); } catch { /* none */ }
  const o = text ? parse(text) : null;
  if (o?.accessToken) return o;
  throw new CloudError('login', platform === 'darwin'
    ? `Claude Code's claude.ai login couldn't be read (the login Keychain item "${KEYCHAIN_SERVICE}", or ${file}). Sign in with \`claude auth login\`; a managed Mac may not let other programs read it.`
    : `No claude.ai login in ${file}. Sign in with \`claude auth login\`.`);
}

// The account's organization, which the API wants as a header: from Claude Code's ~/.claude.json.
function organization(env, home) {
  const file = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json');
  try { return JSON.parse(readFileSync(file, 'utf8'))?.oauthAccount?.organizationUuid ?? null; } catch { return null; }
}

// ---------- the list ----------

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One session as the API lists it, in the few fields a caller needs. null for a row without an id.
export function sessionOf(row) {
  const id = cloudId(row?.id);
  if (!id) return null;
  const meta = row.external_metadata ?? {};
  const sum = meta.post_turn_summary ?? {};
  const source = (row.config?.sources ?? []).find((s) => s?.type === 'git_repository') ?? null;
  const branches = meta.current_branches && typeof meta.current_branches === 'object' ? Object.values(meta.current_branches).filter((b) => typeof b === 'string') : [];
  return {
    id,
    cse_id: cseId(row.id),
    url: cloudUrl(row.id),
    kind: str(row.environment_kind),
    title: str(row.title) ?? '',
    status: str(row.status), // active | archived
    worker_status: str(row.worker_status), // running | idle | requires_action
    status_bucket: str(row.status_bucket),
    created_at: str(row.created_at),
    last_event_at: str(row.last_event_at),
    summary: str(sum.recent_action), // what it did, a line
    needs: str(sum.needs_action), // what it needs from the user; null when nothing
    detail: str(sum.status_detail) ?? str(row.status_line),
    cost_usd: num(meta.usage?.cost_usd),
    repo: str(source?.url),
    branch: branches[0] ?? str(source?.revision),
  };
}

// Every cloud session on the account (`anthropic_cloud`; with `all`, the Remote Control "bridge" rows too), newest
// first as the API gives them. Up to `pages` pages of `limit`. Rejects with a CloudError.
export async function listCloudSessions({
  fetch: fetchImpl = globalThis.fetch, platform = process.platform, env = process.env, home = homedir(), api = API,
  credentialsFile = null, exec = run, all = false, limit = 100, pages = 5, timeoutMs = 15_000,
} = {}) {
  const login = await readLogin({ platform, env, home, credentialsFile, exec });
  if (Number.isFinite(login.expiresAt) && login.expiresAt < Date.now()) {
    throw new CloudError('auth', 'The stored claude.ai login has expired; Claude Code refreshes it the next time it runs.');
  }
  const org = organization(env, home);
  const headers = {
    authorization: `Bearer ${login.accessToken}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': BETA,
    'content-type': 'application/json',
    ...(org ? { 'x-organization-uuid': org } : {}),
  };
  const out = [];
  let after = null;
  for (let page = 0; page < pages; page++) {
    const url = `${api.replace(/\/+$/, '')}/v1/code/sessions?limit=${limit}${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new CloudError('network', `The cloud sessions list didn't answer: ${err?.message ?? err}`);
    }
    if (res.status === 401) throw new CloudError('auth', 'The API refused the stored claude.ai login (401); Claude Code refreshes it the next time it runs.', { status: 401 });
    let body = null;
    let text = '';
    try { text = await res.text(); body = JSON.parse(text); } catch { /* below */ }
    if (!res.ok) throw new CloudError('http', `The cloud sessions list answered ${res.status}: ${`${body?.error?.message ?? text}`.replace(/\s+/g, ' ').slice(0, 200)}`, { status: res.status });
    if (!body || !Array.isArray(body.data)) throw new CloudError('format', 'The cloud sessions list answered in a form this version doesn\'t read.');
    for (const row of body.data) {
      const s = sessionOf(row);
      if (s && (all || s.kind === 'anthropic_cloud')) out.push(s);
    }
    const last = body.last_id ?? body.data.at(-1)?.id ?? null;
    if (!body.has_more || !last || last === after) break;
    after = last;
  }
  return out;
}

// ---------- start, send, attach ----------

const shq = (s) => `'${`${s}`.replace(/'/g, `'\\''`)}'`;
// Terminal control sequences, and carriage returns, out of what a pty printed.
export const plain = (s) => `${s}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[@-_]/g, '').replace(/\r/g, '');

// A command under a pty, through `script`: macOS's takes the command as arguments (and stays open until its stdin
// closes, even after the command exits), Linux's takes a shell line with -c and ends with its command.
export function ptyArgv(argv, platform = process.platform) {
  if (platform === 'darwin' || platform === 'freebsd') return ['script', ['-q', '/dev/null', ...argv]];
  return ['script', ['-qec', argv.map(shq).join(' '), '/dev/null']];
}

// Runs a command under a pty until `done(text)` returns a value (then its stdin is closed and, a moment later, it is
// killed if still there), it exits, or the time runs out. Answers { value, text, code, timedOut }.
export function runInPty(argv, { cwd, env, platform = process.platform, timeoutMs = 90_000, done = () => undefined, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const [cmd, args] = ptyArgv(argv, platform);
    let text = '';
    let value;
    let finished = false;
    let child;
    // macOS's script refuses a socket as its stdin (tcgetattr: "Operation not supported on socket"), and a pipe from
    // node is a socket there; /dev/null it takes (not a terminal), and it then ends when its command does.
    const mac = platform === 'darwin' || platform === 'freebsd';
    try { child = spawnImpl(cmd, args, { cwd, env, stdio: [mac ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ value: undefined, text: e.message, code: 127, timedOut: false }); }
    const end = (code, timedOut = false) => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(grace); resolve({ value, text, code, timedOut }); };
    let grace = null;
    const stop = () => {
      try { child.stdin.end(); } catch { /* closed */ }
      grace = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 1500);
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } end(null, true); }, timeoutMs);
    const take = (d) => {
      text += plain(d);
      if (value === undefined) {
        const v = done(text);
        if (v !== undefined) { value = v; stop(); }
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.stdin?.on('error', () => {});
    child.on('error', (e) => { text += e.message; end(127); });
    child.on('close', (code) => end(code ?? 0));
  });
}

// The lines `claude --cloud` prints once it made a session: "Created cloud session: <title>" and "View: <url>".
export function parseStarted(text) {
  const view = /View:\s*(https:\/\/claude\.ai\/code\/\S+)/.exec(text);
  const id = view ? cloudId(view[1].replace(/[?#].*$/, '')) : null;
  if (!id) return null;
  const title = /Created cloud session:\s*(.+)/.exec(text)?.[1]?.trim() ?? null;
  return { id, url: cloudUrl(id), title };
}

// Starts a cloud session for the repo `cwd` is in: the brief is its first message, `title` its name. The session
// works from the repo's GitHub copy at the pushed branch (a caller should check the tree is clean and pushed: unpushed
// work is left out). Rejects with a CloudError: 'trust' (Claude Code wants the folder trusted first), 'start'.
export async function startCloudSession({ brief, title, cwd, claude = 'claude', env = process.env, platform = process.platform, timeoutMs = 90_000, spawnImpl = spawn } = {}) {
  const argv = [claude, '--cloud', brief, ...(title ? ['-n', title] : [])];
  const r = await runInPty(argv, {
    cwd, env, platform, timeoutMs, spawnImpl,
    done: (text) => parseStarted(text) ?? (/trust (?:the files in )?this folder/i.test(text) ? null : undefined),
  });
  if (r.value) return { ...r.value, title: r.value.title ?? title ?? null, output: r.text };
  if (r.value === null) throw new CloudError('trust', `Claude Code wants ${cwd} trusted before it starts there: run \`claude\` in it once and accept.`);
  const said = r.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const error = said.find((l) => /^Error:/.test(l)) ?? said.at(-1) ?? (r.timedOut ? 'no answer' : 'no output');
  throw new CloudError('start', `claude --cloud didn't start a session${r.timedOut ? ` within ${Math.round(timeoutMs / 1000)}s` : ''}: ${error.slice(0, 300)}`);
}

// A message to a cloud session, as its next user message. It starts a turn in an idle session. Behind an open
// question it doesn't answer it: it waits until the question is answered (on claude.ai, or in an attached terminal).
// Answers { id, url }; rejects with a CloudError 'send'.
export async function sendToCloudSession({ id, text, claude = 'claude', env = process.env, cwd, exec = run, timeoutMs = 60_000 } = {}) {
  const sid = cloudId(id);
  if (!sid) throw new CloudError('send', `"${id}" isn't a cloud session id.`);
  const r = await exec(claude, ['-p', text, '--cloud', sid, '--output-format', 'json'], { env, cwd, timeout: timeoutMs });
  let said = null;
  for (const line of `${r.out}`.trim().split('\n').reverse()) { try { said = JSON.parse(line); break; } catch { /* not it */ } }
  if (r.code !== 0 || !said?.ok) {
    const why = `${r.err || r.out || 'no output'}`.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? 'no output';
    throw new CloudError('send', `The message didn't reach ${sid}: ${why.replace(/^Error:\s*/, '').slice(0, 300)}`);
  }
  return { id: sid, url: cloudUrl(said.session_id ?? sid) };
}

// Whether `claude --cloud <id>` attaches a terminal for this account, found by asking it, with a well-formed id that
// names no session: 'off' when it says attaching isn't enabled for the account (it says so before asking the server),
// 'on' when it got as far as the session (it isn't found), 'unknown' otherwise. Nothing is changed to find out.
const PROBE_ID = 'session_01000000000000000000000000';
export async function probeAttach({ claude = 'claude', env = process.env, cwd, platform = process.platform, timeoutMs = 20_000, spawnImpl = spawn } = {}) {
  const r = await runInPty([claude, '--cloud', PROBE_ID], {
    cwd, env, platform, timeoutMs, spawnImpl,
    done: (text) => (/not enabled for your account/i.test(text) ? 'off' : /not found|no such session|does not exist|invalid session/i.test(text) ? 'on' : undefined),
  });
  return r.value ?? 'unknown';
}
