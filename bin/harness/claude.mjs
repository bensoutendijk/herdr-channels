// The Claude Code harness: everything channels knows about Claude Code's own sessions, behind the harness interface
// (bin/harness/index.mjs, and docs/harnesses.md §2). A task here is one Claude Code background session: `claude --bg`
// starts it, its records (~/.claude/jobs, ~/.claude/sessions, the transcripts under ~/.claude/projects) say where it
// stands and what it said, and a message stops and resumes it.
//
// Plain functions with no state of their own: `deps` (bin/channels.mjs, defaultDeps) carries the home folder, the
// `claude` to run and how to run programs, so the tests run them against fixtures.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A refusal the user can act on: bin/channels.mjs prints its message and exits 1, as for its own.
export class HarnessError extends Error {
  constructor(msg) { super(msg); this.name = 'UsageError'; }
}
const fail = (msg) => { throw new HarnessError(msg); };
const oneLine = (s) => `${s ?? ''}`.replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const id = 'claude';
export const label = 'Claude Code';
// What the mod and the chat's prompt may offer for a task on this harness (docs/harnesses.md §2).
export const caps = {
  rename: true, remoteControl: true, cloud: true, approvals: false, open: true,
  sendWhileWorking: 'refuse', question: 'job', copies: true,
};

// ---------- Claude Code's own records ----------

export const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const countLines = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

export function jobState(home, job) {
  if (!job || !/^[A-Za-z0-9_-]{1,64}$/.test(job)) return null;
  return readJson(join(home, '.claude', 'jobs', job, 'state.json'));
}

// Background jobs by session id. `work` counts the job's timeline entries: Claude Code adds them only while the
// session works, so the same count means no new work.
export function readJobs(home) {
  const dir = join(home, '.claude', 'jobs');
  const out = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const job of names) {
    const s = readJson(join(dir, job, 'state.json'));
    if (!s?.sessionId) continue; // not a job folder, or its state isn't written yet
    out.set(s.sessionId, {
      job, state: s.state, detail: s.detail ?? '', needs: s.needs ?? null, cwd: s.cwd ?? null, name: s.name ?? '',
      nameSource: s.nameSource ?? null, inFlight: Number(s.inFlight?.tasks) || 0, result: s.output?.result ?? null,
      updatedAt: s.updatedAt ?? null, transcript: s.linkScanPath ?? null, bridge: s.bridgeSessionId ?? null, work: countLines(join(dir, job, 'timeline.jsonl')),
    });
  }
  return out;
}

export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

// Each running Claude Code process's own record (~/.claude/sessions/<pid>.json), by session id: its status
// (busy, idle, waiting on a dialog), what it waits for, its name. Records of processes that ended are skipped.
export function readLive(home) {
  const dir = join(home, '.claude', 'sessions');
  const out = new Map();
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const s = readJson(join(dir, f));
    if (!s?.sessionId || !Number.isInteger(s.pid) || !alive(s.pid)) continue;
    // Another process can hold the same session (someone has it open in a terminal): the job's own process wins.
    if (out.get(s.sessionId)?.job && !s.jobId) continue;
    out.set(s.sessionId, { pid: s.pid, status: s.status ?? null, waitingFor: s.waitingFor ?? null, name: s.name ?? '', nameSource: s.nameSource ?? null, job: s.jobId ?? null, cwd: s.cwd ?? null, bridge: s.bridgeSessionId ?? null, version: s.version ?? null, kind: s.kind ?? null });
  }
  return out;
}

// Whether a session's last turn has ended, from the end of its transcript: Claude Code writes a "turn_duration" line
// when a turn ends, after the turn's last message. true when that line comes after the last message, false when a
// message does (a prompt, a tool call or its result: a turn is under way), null when the transcript can't say.
// Subagents' messages (isSidechain) are not the session's own turn.
export const TURN_TAIL = 256 * 1024;
export function turnEnded(file) {
  if (!file) return null;
  let text;
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TURN_TAIL);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; } // a line being written, or cut by the tail
    if (!r || r.isSidechain) continue;
    if (r.type === 'system' && r.subtype === 'turn_duration') return true;
    if (r.type === 'user' || r.type === 'assistant') return false;
  }
  return null;
}

// What a session that ended its turn while background work it started still runs is doing, in a word for the user.
const backgroundDoing = (n) => (n > 1 ? `Its turn is over, but ${n} background tasks it started are still running` : 'Its turn is over, but a background task it started is still running');

// A session's state from what Claude Code says about it: working, waiting_on_job (its turn is over, but a background
// task it started still runs), waiting_on_user (a dialog in the session needs the user), blocked (it ended its turn
// asking for something), failed or done. Claude Code calls a session busy while a background subagent it started runs,
// its own turn over or not: `turnOver` (turnEnded, from its transcript) tells the two apart.
export function stateOf({ live = null, job = null, turnOver = null } = {}) {
  const status = live?.status ?? null;
  if (status === 'waiting') return { state: 'waiting_on_user', doing: `Waiting on you: ${live.waitingFor || 'a prompt'}` };
  if (status === 'busy') {
    if (turnOver === true && job?.inFlight > 0) return { state: 'waiting_on_job', doing: backgroundDoing(job.inFlight) };
    return { state: 'working', doing: job?.detail || 'Working' };
  }
  if (status === 'shell') return { state: 'waiting_on_job', doing: 'Its turn is over, but a background command it started is still running' };
  if (live && status && status !== 'idle') return { state: 'working', doing: job?.detail || `Claude Code says "${status}"` };
  if (job) {
    if (job.state === 'working') {
      if (!live) return { state: 'paused', doing: 'Its process stopped while it was working' };
      return job.inFlight > 0 ? { state: 'waiting_on_job', doing: backgroundDoing(job.inFlight) } : { state: 'working', doing: job.detail || 'Working' };
    }
    if (job.state === 'blocked') return { state: 'blocked', doing: job.needs || job.detail || 'Blocked' };
    if (job.state === 'failed') return { state: 'failed', doing: job.detail || 'Failed' };
    if (job.state === 'stopped') return { state: 'done', doing: 'Stopped' };
    if (job.state === 'done') return { state: 'done', doing: job.detail || 'Done' };
    return { state: live ? 'working' : 'done', doing: job.detail || job.state || '' };
  }
  return { state: 'done', doing: live ? 'Its turn ended' : 'Ended' };
}

// stateOf for a session, reading its transcript's end only when it has to: when Claude Code calls it busy while
// background work it started runs.
export function sessionState(home, sid, { live = null, job = null } = {}) {
  const turnOver = live?.status === 'busy' && job?.inFlight > 0 && sid
    ? turnEnded(job.transcript && existsSync(job.transcript) ? job.transcript : findTranscript(home, sid)) : null;
  return stateOf({ live, job, turnOver });
}

export function findTranscript(home, id) {
  const root = join(home, '.claude', 'projects');
  if (!/^[0-9a-f-]{8,64}$/i.test(id) || !existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
export const THREAD = { keep: 40, textChars: 1500 };

// { title, first_prompt, cwd, thread, last }. The thread is oldest first: { who: 'user', at, text },
// { who: 'agent', at, text } and { who: 'tools', calls } for a run of tool calls; each message is cut to
// THREAD.textChars except `last`, the session's last agent message, kept whole.
export function parseTranscript(text) {
  const st = { title: '', aiTitle: '', firstPrompt: '', cwd: null, thread: [], last: null };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // a line being written
    if (r.type === 'custom-title' && r.customTitle) st.title = r.customTitle;
    if (r.type === 'agent-name' && r.agentName) st.title = r.agentName;
    if (r.type === 'ai-title' && r.aiTitle) st.aiTitle = r.aiTitle;
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isSidechain) continue;
    if (!st.cwd && r.cwd) st.cwd = r.cwd;
    const at = r.timestamp || null;
    const content = r.message?.content;
    if (r.type === 'user') {
      const kind = r.origin?.kind;
      if (r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly || (kind && kind !== 'human')) continue;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      const said = textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (!said || (!kind && said.startsWith('<'))) continue;
      if (!st.firstPrompt) st.firstPrompt = said;
      st.thread.push({ who: 'user', at, text: said.slice(0, THREAD.textChars) });
      continue;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text?.trim()) {
        st.last = { at, text: b.text.trim() };
        st.thread.push({ who: 'agent', at, text: st.last.text.slice(0, THREAD.textChars) });
      } else if (b?.type === 'tool_use') {
        const prev = st.thread[st.thread.length - 1];
        if (prev?.who === 'tools') prev.calls++; else st.thread.push({ who: 'tools', at, calls: 1 });
      }
    }
  }
  const thread = st.thread.length <= THREAD.keep ? st.thread : st.thread.slice(-THREAD.keep);
  return { title: st.title || st.aiTitle || '', first_prompt: st.firstPrompt || null, cwd: st.cwd, thread, last: st.last };
}

export function readTranscript(home, id, file = null) {
  const path = file && existsSync(file) ? file : findTranscript(home, id);
  if (!path) return null;
  try { return parseTranscript(readFileSync(path, 'utf8')); } catch { return null; }
}

// A session's current name from its transcript: the last rename, else the title Claude Code gave it. Only those
// lines are parsed. '' when there's none yet.
export function transcriptTitle(home, id) {
  const file = findTranscript(home, id);
  if (!file) return '';
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  for (const [type, field] of [['custom-title', 'customTitle'], ['agent-name', 'agentName'], ['ai-title', 'aiTitle']]) {
    const mark = `"type":"${type}"`;
    let at = text.lastIndexOf(mark);
    while (at !== -1) {
      const start = text.lastIndexOf('\n', at) + 1;
      const end = text.indexOf('\n', at);
      try {
        const name = JSON.parse(text.slice(start, end === -1 ? undefined : end))[field];
        if (typeof name === 'string' && name.trim()) return name.trim();
      } catch { /* a line being written */ }
      at = start > 0 ? text.lastIndexOf(mark, start - 1) : -1;
    }
  }
  return '';
}

// ---------- Remote Control ----------

// Remote Control: when it is on (CHANNELS_REMOTE_CONTROL, which install.mjs writes into the installed command), the
// chat and every task `start` makes also show at claude.ai/code and in the Claude app. Only the flags this command
// passes turn it on; the user's own Claude Code settings are never touched.
export const remoteOn = (env = process.env) => /^(1|on|yes|true)$/i.test(`${env.CHANNELS_REMOTE_CONTROL ?? ''}`.trim());

// A Remote Control session id (cse_… in a job record and the transcript, session_… in a live record) as its
// claude.ai/code link, or null.
export function remoteLink(bridge) {
  const m = /^(?:cse|session)_([A-Za-z0-9]{8,64})$/.exec(`${bridge ?? ''}`.trim());
  return m ? `https://claude.ai/code/session_${m[1]}` : null;
}

// The last Remote Control session id a transcript records ("bridge-session" lines), or null.
export function transcriptBridge(text) {
  const mark = '"type":"bridge-session"';
  let at = `${text ?? ''}`.lastIndexOf(mark);
  while (at !== -1) {
    const start = text.lastIndexOf('\n', at) + 1;
    const end = text.indexOf('\n', at);
    try {
      const id = JSON.parse(text.slice(start, end === -1 ? undefined : end)).bridgeSessionId;
      if (remoteLink(id)) return id;
    } catch { /* a line being written */ }
    at = start > 0 ? text.lastIndexOf(mark, start - 1) : -1;
  }
  return null;
}

// A session's claude.ai/code link, when it has had Remote Control: from its job's record (kept after the process
// exits), else its running process's record, else its transcript (which `transcript: false` skips, as list does for
// a session that has a job). It stays the same across `send` and a chat's restart; a copy gets a link of its own.
export function remoteUrl(home, { sessionId = null, job = null, live = null, transcript = true, file = null } = {}) {
  const fromJob = remoteLink(job?.bridge ?? job?.bridgeSessionId);
  if (fromJob) return fromJob;
  const fromLive = remoteLink(live?.bridge ?? live?.bridgeSessionId);
  if (fromLive) return fromLive;
  if (!transcript || !sessionId) return null;
  const path = file && existsSync(file) ? file : findTranscript(home, sessionId);
  if (!path) return null;
  try { return remoteLink(transcriptBridge(readFileSync(path, 'utf8'))); } catch { return null; }
}

// ---------- running claude ----------

// Variables a Claude Code session sets for the programs it runs. A task started from the chat's Bash would inherit
// them and run as that session's child (no transcript of its own), so they are taken out. Settings such as
// CLAUDE_CONFIG_DIR or a provider's CLAUDE_CODE_USE_* stay.
const SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_JOB_DIR', 'CLAUDE_PID', 'CLAUDE_EFFORT'];
export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of SESSION_ENV) delete out[k];
  return out;
}

export async function listAgents(deps) {
  const r = await deps.run(deps.claude, ['agents', '--json', '--all'], { cwd: deps.home, timeout: 30_000 });
  if (r.code !== 0) return [];
  try { const all = JSON.parse(r.out); return Array.isArray(all) ? all : []; } catch { return []; }
}

function onPath(cmd) {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  for (const d of `${process.env.PATH ?? ''}`.split(':')) if (d && existsSync(join(d, cmd))) return join(d, cmd);
  return null;
}

// The Claude Code version a new claude would run. The native installer's `claude` links into versions/<version>, which
// says it without running anything; otherwise `claude --version`, remembered for that binary (path, size, mtime).
export async function installedClaude({ dir, deps }) {
  const path = onPath(deps.claude);
  if (!path) return null;
  const target = (() => { try { return realpathSync(path); } catch { return path; } })();
  const named = /^(\d+\.\d+\.\d+[^/]*)$/.exec(target.split('/').pop());
  if (named) return named[1];
  let st;
  try { st = statSync(target); } catch { return null; }
  const key = `${target}:${st.size}:${st.mtimeMs}`;
  const file = join(dir, 'claude-version.json');
  const was = readJson(file);
  if (was?.key === key) return was.version;
  const r = await deps.run(deps.claude, ['--version'], { cwd: deps.home, env: cleanEnv(), timeout: 20_000 });
  const version = (/(\d+\.\d+\.\d+)/.exec(r.out) || [])[1] ?? null;
  if (version) {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ key, version })}\n`);
      renameSync(tmp, file);
    } catch { /* not remembered */ }
  }
  return version;
}

// ---------- the harness interface ----------

// Whether Claude Code is here, and its version: { version } or null.
export async function installed({ dir, deps }) {
  const version = await installedClaude({ dir, deps });
  return version ? { version } : null;
}

// A background session for a task: `claude --bg` in `cwd`. The brief is its first message, and all it gets. With
// Remote Control on, the task also shows at claude.ai/code under its name. `send` passes no flags: Claude Code resumes
// a background session with the options it started with, this one included. Answers { session_id, job }.
export function checkStart({ mode = null } = {}) {
  if (mode != null && mode !== '' && !/^[A-Za-z]{1,32}$/.test(mode)) fail('--permission-mode is one of Claude Code\'s permission modes, such as "auto" or "default".');
}
export async function start({ deps, cwd, brief, name, model = null, mode = null }) {
  checkStart({ mode });
  const args = ['--bg', ...(remoteOn() ? ['--remote-control', name] : []), '-n', name, ...(mode ? ['--permission-mode', mode] : []), ...(model ? ['--model', model] : []), brief];
  const r = await deps.run(deps.claude, args, { cwd, env: cleanEnv(), timeout: 90_000 });
  const said = `${r.out}\n${r.err}`;
  const job = (/backgrounded · (\S+)/.exec(said) || /claude attach (\S+)/.exec(said) || [])[1];
  if (!job) fail(`Claude Code didn't start a session in ${cwd}: ${cut(oneLine(r.err || r.out || 'no output'), 300)}`);
  // The session id is written a moment after the job starts.
  let sessionId = null;
  for (let k = 0; k < 30 && !sessionId; k++) {
    sessionId = jobState(deps.home, job)?.sessionId ?? null;
    if (!sessionId) await deps.sleep(300);
  }
  return { session_id: sessionId, job };
}

// One cheap look at every session, for the looks that follow (look, row): the jobs and the running processes.
export function scan({ deps }) {
  const live = readLive(deps.home);
  return { home: deps.home, jobs: readJobs(deps.home), live, names: liveNames(live) };
}

// The name of each running Claude Code process's session. A name Claude Code made up from the folder
// (nameSource "derived") isn't one: it's left out.
export function liveNames(live) {
  const out = new Map();
  for (const [id, s] of live) if (s.name?.trim() && s.nameSource !== 'derived') out.set(id, s.name.trim());
  return out;
}

const sessionIdOf = (home, t) => t.session_id ?? jobState(home, t.job)?.sessionId ?? null;

// The name the store keeps for a task over Claude Code's, or null. A copy Claude Code started in a task's place keeps
// the task's name, unless the copy's job was renamed by someone (Claude Code names a copy from the message it was
// sent). A session with no job that was renamed with rename-task keeps that name: Claude Code has no way to rename it
// from outside (see renameTask in bin/channels.mjs).
export function keptName(t, job) {
  if (t.how === 'copied' && t.name && job?.nameSource !== 'user') return t.name;
  if (t.named === 'user' && t.name && !job) return t.name;
  return null;
}

// What the listener would say about a task right now (a Snap, docs/harnesses.md §2), and the mark that says it was
// said: a finished task is news again only after it did more work (its timeline grew, or its transcript did for a
// session with no job). Fields, in channels' words:
//   sid, st { state, doing }, kind ('done' | 'needs' | null), mark { kind, work }, prompt (a live dialog, not a
//   question), waiting (what a needs waits on), needs, result, detail, at, kept (the store's name over the
//   harness's), agentName (the harness's name), liveWaiting (what a live dialog says it waits for)
export function look(sc, t) {
  const { home, jobs, live } = sc;
  const sid = sessionIdOf(home, t);
  const job = sid ? jobs.get(sid) ?? null : null;
  const l = sid ? live.get(sid) ?? null : null;
  const st = sessionState(home, sid, { live: l, job });
  const kind = st.state === 'done' || st.state === 'failed' ? 'done' : st.state === 'waiting_on_user' || st.state === 'blocked' ? 'needs' : null;
  let work = job?.work ?? 0;
  if (!job && sid) { const f = findTranscript(home, sid); try { work = f ? statSync(f).size : 0; } catch { work = 0; } }
  const prompt = st.state === 'waiting_on_user';
  return {
    harness: id, home, sid, job, live: l, st, kind, mark: { kind, work }, prompt,
    waiting: kind === 'needs' ? (prompt ? (job?.state === 'working' && job.needs) || l?.waitingFor || 'a prompt' : st.doing) : null,
    needs: job?.needs ?? null, result: job?.result ?? null, detail: job?.detail ?? null, at: job?.updatedAt ?? null,
    kept: keptName(t, t.job ? jobState(home, t.job) : null), agentName: job?.name || l?.name || '', liveWaiting: l?.waitingFor ?? null,
    transcript: null, last: null, title: '',
  };
}

// Reads the session's own words for what look saw: its last message and its title. Only done when there is something
// to say, as a transcript can be large. Answers the same snap.
export function withLast(now, lastMark) {
  now.transcript = now.sid ? readTranscript(now.home, now.sid, now.job?.transcript) : null;
  now.last = now.transcript?.last?.text ?? null;
  now.title = now.transcript?.title ?? '';
  now.mark.last = lastMark(now.last);
  return now;
}

// The task's claude.ai link, when it has had Remote Control (for a card's Open on claude.ai).
export const remote = (now) => remoteUrl(now.home, { sessionId: now.sid, job: now.job, live: now.live, file: now.job?.transcript });

// One task as `channels list` shows it, with its current Claude Code name: its job's, else its running process's,
// else its transcript's (not read for a dismissed task), else the name it was filed under. Its claude.ai link too,
// when it has had Remote Control (the transcript is read for one only for a session with no job that isn't
// dismissed). Answers { session_id, name, remote_url }.
export function row(sc, t, { local }) {
  const { home, names, live } = sc;
  const job = t.machine === local ? jobState(home, t.job) : null;
  const sessionId = t.session_id ?? job?.sessionId ?? null;
  const url = t.machine === local ? remoteUrl(home, { sessionId, job, live: sessionId ? live.get(sessionId) : null, transcript: !job && !t.dismissed_at }) : null;
  const kept = keptName(t, job);
  if (kept) return { session_id: sessionId, name: kept, remote_url: url };
  let name = job?.name || '';
  if (!name && t.machine === local && sessionId) name = names.get(sessionId) || (t.dismissed_at ? '' : transcriptTitle(home, sessionId));
  return { session_id: sessionId, name: name || t.name || '', remote_url: url };
}

// A session on this machine, from Claude Code's records: a session id, the start of one (6 or more characters) or a
// job id. A session no process or job holds any more is found by its full id in the transcripts.
export async function find({ deps, id, machine }) {
  const byId = new Map();
  for (const [sessionId, j] of readJobs(deps.home)) byId.set(sessionId, { session_id: sessionId, job: j.job, name: j.name || '', cwd: j.cwd || null });
  for (const a of await listAgents(deps)) {
    if (!a?.sessionId) continue;
    const was = byId.get(a.sessionId) ?? { session_id: a.sessionId, job: null, name: '', cwd: null };
    byId.set(a.sessionId, { ...was, job: was.job ?? (a.kind === 'background' ? a.id ?? null : null), name: was.name || a.name || '', cwd: was.cwd || a.cwd || null });
  }
  const want = id.toLowerCase();
  const all = [...byId.values()];
  let hits = all.filter((s) => s.session_id.toLowerCase() === want || s.job?.toLowerCase() === want);
  if (!hits.length && want.length >= 6) hits = all.filter((s) => s.session_id.toLowerCase().startsWith(want));
  if (hits.length > 1) fail(`"${id}" matches ${hits.length} sessions; use a full session id: ${hits.slice(0, 5).map((s) => s.session_id).join(', ')}.`);
  if (hits.length === 1) return hits[0];
  const file = findTranscript(deps.home, id);
  if (file) {
    const t = readTranscript(deps.home, id, file);
    return { session_id: id, job: null, name: t?.title || '', cwd: t?.cwd ?? null };
  }
  fail(`No session ${id} on ${machine}.`);
}

// A session found by `find`, with where it stands: { s, job, live, st }.
export async function facts({ deps, id, machine }) {
  const s = await find({ deps, id, machine });
  const job = readJobs(deps.home).get(s.session_id) ?? null;
  const l = readLive(deps.home).get(s.session_id) ?? null;
  return { s, job, live: l, st: sessionState(deps.home, s.session_id, { live: l, job }) };
}

// A session's state and its latest messages, as `channels read` shows them: { summary, messages, more }. The
// summary's project is filled in by the caller, which knows the projects folder.
export async function read({ deps, id, machine, limit }) {
  const { s, job, live, st } = await facts({ deps, id, machine });
  const t = readTranscript(deps.home, s.session_id, job?.transcript);
  const summary = {
    id: s.session_id, machine, job: s.job, title: job?.name || live?.name || t?.title || s.name || '', state: st.state, doing: st.doing,
    project: null, folder: s.cwd, waiting_on: st.state === 'waiting_on_user' ? (live?.waitingFor || 'a prompt') : st.state === 'blocked' ? st.doing : null,
    result: job?.result ?? null, last_agent_message: t?.last?.text ?? null,
    remote_url: remoteUrl(deps.home, { sessionId: s.session_id, job, live, file: job?.transcript }),
  };
  const thread = t?.thread ?? [];
  // The last agent message is shown whole, the others cut.
  const lastAt = thread.map((x) => x.who).lastIndexOf('agent');
  const messages = thread.slice(-limit).map((x, i, a) => (x.who === 'agent' && thread.length - a.length + i === lastAt && t?.last ? { ...x, text: t.last.text } : x));
  return { summary, messages: messages.reverse(), more: thread.length > limit };
}

// Waits until a process has exited: true, or false when it still runs after `ms`.
export async function exited(deps, pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await deps.sleep(200);
  }
  return true;
}

// What Claude Code's prompt holds on a terminal's screen (`hc read`): the text after its ❯ ('' when empty), or null when
// no prompt is on screen.
export function promptDraft(screen) {
  const lines = `${screen ?? ''}`.split('\n').slice(-40);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*❯(.*)$/.exec(lines[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    if (m) return m[1].replace(/ /g, ' ').trim();
  }
  return null;
}

// Typing into a session's view: how long its view may take to come up, and the message to show in its transcript.
export const VIEW = { upMs: 20_000, seenMs: 30_000, pollMs: 300 };

// Whether the transcript shows the message as a prompt of the session's own (not a subagent's), at or after `since`.
function promptSeen(file, body, since) {
  if (!file) return false;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return false; }
  const want = oneLine(body).slice(0, 120);
  for (const line of text.slice(-TURN_TAIL).split('\n').reverse()) {
    if (!line.includes('"type":"user"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'user' || r.isSidechain) continue;
    if (r.timestamp && Date.parse(r.timestamp) < since) return false;
    if (oneLine(textOf(r.message?.content)).startsWith(want)) return true;
  }
  return false;
}

// A message to a session whose turn is over while background work it started still runs: typed into its view, the
// way the user types into it in the panel. Its own `claude attach` runs for a moment in a terminal of herdr-core's
// (`hc run`); once its prompt is on screen, and empty (a draft the user is typing there shows in every view, and is
// never added to), the message is pasted and sent there (`hc send`), and the terminal is ended. Claude Code takes it
// as the session's next turn, a prompt the user typed, and the background work goes on. It is sent once its
// transcript shows it. Answers { delivered_as: 'typed', job }.
async function typeIntoView({ deps, ref, jobId, sid, job, body }) {
  const busy = (why) => fail(`${ref}'s turn is over, but a background task it started is still running, and ${why}. Run \`channels watch ${ref} --wake-on any\` and send it once that wakes you, or type into it in its view in the panel.`);
  if (!deps.hc) busy('herdr-core (hc) isn\'t here to type the message into its view');
  const transcript = () => (job?.transcript && existsSync(job.transcript) ? job.transcript : findTranscript(deps.home, sid));
  const name = `send-${jobId}-${randomUUID().slice(0, 4)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  const started = await deps.run(deps.hc, ['run', '--bg', '--json', '--no-parent', '--no-notify', '--rm', '--name', name, '--label', `channels.send=${jobId}`,
    '--cwd', deps.home, '--', onPath(deps.claude) ?? deps.claude, 'attach', jobId, '--settings', JSON.stringify({ disableAgentView: true })], { timeout: 30_000 });
  if (started.code !== 0) busy(`herdr-core couldn't open its view to type the message in (hc run: ${cut(oneLine(started.err || started.out || `exit ${started.code}`), 160)})`);
  try {
    const screen = async () => { const r = await deps.run(deps.hc, ['read', name], { timeout: 15_000 }); return r.code === 0 ? promptDraft(r.out) : null; };
    let draft = null;
    for (const until = Date.now() + VIEW.upMs; draft === null && Date.now() < until;) {
      draft = await screen();
      if (draft === null) await deps.sleep(VIEW.pollMs);
    }
    if (draft === null) busy('its view didn\'t show its prompt, so the message wasn\'t typed in');
    // Claude Code may show a suggestion for the next prompt, which reads like a draft. A key typed replaces a
    // suggestion but adds to a draft, so a prompt that then holds just that key was empty; the key is taken back.
    if (draft) {
      await deps.run(deps.hc, ['keys', name, 'x'], { timeout: 15_000 });
      const typed = await screen();
      await deps.run(deps.hc, ['keys', name, 'backspace'], { timeout: 15_000 });
      if (typed === 'x') draft = '';
    }
    if (draft) fail(`${ref}'s turn is over (a background task it started still runs), but a draft is typed in its prompt, and the message would be added to it. Nothing was sent: send or clear the draft in its view in the panel, then send again.`);
    // Claude Code's word again, the moment before: still the same process, its turn still over.
    const now = sessionState(deps.home, sid, { live: readLive(deps.home).get(sid) ?? null, job: readJobs(deps.home).get(sid) ?? null });
    if (now.state === 'working') fail(`${ref} is working. Send it after it finishes; or type into it in its view in the panel.`);
    if (now.state !== 'waiting_on_job') fail(`${ref} changed while the message was being typed in (${now.state}: ${now.doing}). Nothing was sent; send it again.`);
    const since = Date.now() - 2000;
    const sent = await deps.run(deps.hc, ['send', name, body], { timeout: 60_000 });
    if (sent.code !== 0) fail(`Couldn't type the message into ${ref}'s view: ${cut(oneLine(sent.err || sent.out || `hc exited ${sent.code}`), 200)}`);
    for (const until = Date.now() + VIEW.seenMs; ;) {
      if (promptSeen(transcript(), body, since)) return { delivered_as: 'typed', job: jobId };
      if (Date.now() >= until) break;
      await deps.sleep(VIEW.pollMs);
    }
    fail(`The message was typed into ${ref}'s view, but its transcript doesn't show it after ${VIEW.seenMs / 1000}s. Check with \`channels read ${ref}\` before sending it again.`);
  } finally {
    await deps.run(deps.hc, ['kill', name], { timeout: 15_000 });
  }
}

// The message itself, to a session `facts` found. One whose turn is over (done, or ended asking something) is woken
// with it: its process is stopped, and once that process has exited the same session resumes in the background with
// the message as its next turn (`claude --bg --resume` on a session whose process still runs starts a copy instead).
// One whose turn is over while background work it started still runs (a subagent, a background command) isn't
// stopped, as that would stop the work: the message is typed into its view instead (typeIntoView). A session still
// working, or showing a dialog, isn't interrupted; one that isn't a background job can't be reached.
// Answers { delivered_as: 'resumed', job }, { delivered_as: 'typed', job } or { delivered_as: 'copy_started', job,
// copy_session_id, why }: a copy is Claude Code's own doing (why says what it and send saw), and the caller files it.
export async function send({ deps, facts: { s, job, live, st }, body, machine, stopWaitMs }) {
  const ref = `${machine}/${s.session_id}`;
  if (!job && !s.job) fail(`${ref} isn't a background session, so a message can't reach it: continue it where it runs.`);
  if (live && st.state === 'working') fail(`${ref} is working. Send it after it finishes; or type into it in its view in the panel.`);
  if (st.state === 'waiting_on_user') fail(`${ref} is showing a prompt (${live?.waitingFor || 'a dialog'}): answer it in its view in the panel.`);
  const jobId = job?.job ?? s.job;
  // Its turn is over but background work it started still runs: stopping it would stop that work, and resuming a
  // session whose process runs starts a copy. So the message is typed into its view, as the user would.
  if (live && st.state === 'waiting_on_job') return typeIntoView({ deps, ref, jobId, sid: s.session_id, job, body });
  const secs = `${Math.round(stopWaitMs / 100) / 10}s`;
  // The job's own process, to stop: not someone's interactive Claude Code that has the session open.
  const own = live?.kind === 'interactive' ? null : live;
  if (own) {
    const stop = await deps.run(deps.claude, ['stop', jobId], { cwd: deps.home, env: cleanEnv(), timeout: 60_000 });
    if (stop.code !== 0) fail(`Couldn't stop ${jobId} to wake it: ${cut(oneLine(stop.err || stop.out || 'no output'), 240)}`);
    if (!(await exited(deps, own.pid, stopWaitMs))) {
      fail(`${ref} was told to stop, but its process (pid ${own.pid}) still runs after ${secs}. The message wasn't sent and nothing was started, since resuming it now would start a copy. Send it again in a moment.`);
    }
  }
  // Claude Code starts a copy when any background process of its own still holds the session, not only the one
  // stopped above (issue #58): another record of the session, or a worker its daemon still lists. Those are waited
  // for too, as long as the stop was.
  const left = await released(deps, s.session_id, stopWaitMs);
  if (left.length) {
    fail(`${ref} still has a Claude Code background process after ${secs} (${left.map(holderLine).join('; ')}). The message wasn't sent and nothing was started, since resuming it now would start a copy. Send it again in a moment.`);
  }
  // Resumed from the folder the session last worked in, as its transcript says (a worktree it moved into, say),
  // which is where Claude Code keeps its transcript; the folder it started in when that one is gone.
  const file = job?.transcript && existsSync(job.transcript) ? job.transcript : findTranscript(deps.home, s.session_id);
  const worked = transcriptCwd(file);
  const cwd = [worked, own?.cwd, job?.cwd, s.cwd].find((d) => d && existsSync(d)) || deps.projects;
  // The message goes after `--`: a message that starts with "-" would otherwise be read as options, and a resume
  // with options of its own starts a copy (and drops the message).
  const before = { stillRan: Boolean(own && alive(own.pid)), others: holders(deps.home, s.session_id) };
  const r = await deps.run(deps.claude, ['--bg', '--resume', s.session_id, '--', body], { cwd, env: cleanEnv(), timeout: 90_000 });
  const said = `${r.out}\n${r.err}`;
  const woke = (/backgrounded · (\S+)/.exec(said) || [])[1];
  if (!woke) fail(`The session didn't resume: ${cut(oneLine(r.err || r.out || 'no output'), 240)}`);
  if (woke === jobId) return { delivered_as: 'resumed', job: woke };
  // A copy: a new session with the same history and the message as its next turn. Its session id is written a
  // moment after it starts.
  let copyId = null;
  for (let k = 0; k < 30 && !copyId; k++) {
    copyId = jobState(deps.home, woke)?.sessionId ?? null;
    if (!copyId) await deps.sleep(300);
  }
  return { delivered_as: 'copy_started', job: woke, copy_session_id: copyId, why: copyWhy({ said, live: own, ...before, cwd, worked }) };
}

// The folder a session last worked in, from its transcript: each line records the session's folder at the time, and
// it changes when the session moves into a worktree. null when the transcript doesn't say.
export function transcriptCwd(file) {
  if (!file) return null;
  let text;
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TURN_TAIL);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cwd"')) continue;
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r && !r.isSidechain && typeof r.cwd === 'string' && r.cwd) return r.cwd;
  }
  return null;
}

// The Claude Code processes that hold a session, as Claude Code itself counts them before a resume: every live
// record of the session (~/.claude/sessions), whatever its pid, but an interactive one that parked it as a background
// job (an attached view). [{ pid, kind, cwd }].
export function holders(home, sid) {
  const dir = join(home, '.claude', 'sessions');
  const out = [];
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const r = readJson(join(dir, f));
    if (r?.sessionId !== sid || !Number.isInteger(r.pid) || !alive(r.pid)) continue;
    if (r.kind === 'interactive' && r.parkedJobId) continue;
    out.push({ pid: r.pid, kind: r.kind ?? null, cwd: r.cwd ?? null });
  }
  return out;
}
const holderLine = (h) => `pid ${h.pid}${h.kind ? `, ${h.kind}` : ''}${h.via ? `, ${h.via}` : ''}`;

// Waits until no background process holds the session: no live record of it of a background kind, and no worker
// with a pid in `claude agents`. Interactive ones (someone has it open in a terminal) aren't waited for; Claude Code
// copies over those, and the copy's note says so. Answers what still holds it after `ms` ([] when nothing does).
async function released(deps, sid, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const left = holders(deps.home, sid).filter((h) => h.kind !== 'interactive');
    if (!left.length) {
      const a = (await listAgents(deps)).find((x) => x?.sessionId === sid && x.kind !== 'interactive' && Number.isInteger(x.pid) && alive(x.pid));
      if (!a) return [];
      left.push({ pid: a.pid, kind: a.kind ?? null, via: 'listed by claude agents' });
    }
    if (Date.now() > until) return left;
    await deps.sleep(200);
  }
}

// Why a resume started a copy, for the user: Claude Code's own note on it (it prints one, naming the reason), and
// what send saw as it resumed: a process that still held the session, and the folder it resumed from.
export function copyWhy({ said = '', live = null, stillRan = false, others = [], cwd = null, worked = null } = {}) {
  const note = /^note: (.+)$/m.exec(said)?.[1]?.trim() ?? null;
  const parts = [note ? `Claude Code said: "${note}"` : 'Claude Code gave no reason.'];
  const seen = [];
  if (live) seen.push(stillRan ? `its process (pid ${live.pid}) still ran` : `its process (pid ${live.pid}) had exited after the stop`);
  else seen.push('it had no process running');
  const more = others.filter((h) => h.pid !== live?.pid);
  if (more.length) seen.push(`${more.length > 1 ? 'other Claude Code processes' : 'another Claude Code process'} had it open (${more.map(holderLine).join('; ')})`);
  if (cwd) seen.push(worked && worked !== cwd ? `it was resumed from ${cwd}, not ${worked}, where its transcript says it last worked` : `it was resumed from ${cwd}${worked ? ', where its transcript says it last worked' : ''}`);
  return `${parts.join(' ')} When it was resumed, ${seen.join(', ')}.`;
}

// The job a session runs as, when it is a background one.
export const jobOf = (home, t) => t.job ?? (t.session_id ? readJobs(home).get(t.session_id)?.job : null) ?? null;

// Renames a background session in Claude Code, as its own agents view (`claude agents`, Rename) does: the job's
// state.json gets the name with nameSource "user". `claude respawn` and a resume keep it, and Claude Code's own naming
// never replaces a name the user gave. A running session usually takes the name on from that file within a moment (no
// turn starts), but not always: `claude agents` lists what its process holds, its own record in ~/.claude/sessions,
// so takeName below checks that (and helps it along) before anyone is told the agents view shows it. The session's process writes the
// same file as it works, read-change-write, so a write of ours can be lost to one of its writes: the name is read
// back and written again until it holds. true when the job holds the name, false when it has no state to rename.
export async function renameJob(deps, job, name) {
  if (!job || !/^[A-Za-z0-9_-]{1,64}$/.test(job)) return false;
  const file = join(deps.home, '.claude', 'jobs', job, 'state.json');
  for (let k = 0; k < 5; k++) {
    const s = readJson(file);
    if (!s || typeof s !== 'object') return false;
    if (s.name === name && s.nameSource === 'user') {
      if (k > 0) return true;
    } else {
      const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ...s, name, nameSource: 'user', updatedAt: new Date().toISOString() }, null, 2)}`, { mode: 0o600 });
      renameSync(tmp, file);
    }
    await deps.sleep(k === 0 ? 400 : 250);
  }
  const s = readJson(file);
  return Boolean(s && s.name === name && s.nameSource === 'user');
}

// Whether the session's running process has taken a name written to its job (renameJob): its own record in
// ~/.claude/sessions is what `claude agents` and the panel show. Looked at for a moment (CHANNELS_LIVE_NAME_MS), as the
// process takes a new name from the job's file shortly after it is written. { live: false } when no process runs it
// (the next one starts with the job's name); else { live: true, took, shows }: shows is the name it still has.
export async function liveName(deps, sessionId, name, waitMs = Number(process.env.CHANNELS_LIVE_NAME_MS ?? 1500)) {
  if (!sessionId) return { live: false };
  const until = Date.now() + waitMs;
  for (;;) {
    const l = readLive(deps.home).get(sessionId) ?? null;
    if (!l) return { live: false };
    if (l.name === name) return { live: true, took: true, shows: name };
    if (Date.now() >= until) return { live: true, took: false, shows: l.name || '' };
    await deps.sleep(250);
  }
}

// Gets a running session to take a name renameJob gave its job, and says whether it did (liveName's answer). Claude
// Code 2.1.332's process takes a name from its job's file only when it differs from the last name it saw there, and
// a copy (`claude --bg --resume` while the original ran) first saw the original's name there before it named itself
// from its message: renamed back to the task's name, it ignores the write and keeps its own. So when it hasn't taken
// the name, the job is given a passing name first, then the name again, each of which it takes as a change.
export async function takeName(deps, job, sessionId, name) {
  const first = await liveName(deps, sessionId, name);
  if (!first.live || first.took) return first;
  const passing = `${name} (renaming)`;
  if (!(await renameJob(deps, job, passing))) return first;
  await liveName(deps, sessionId, passing);
  if (!(await renameJob(deps, job, name))) return first;
  return liveName(deps, sessionId, name);
}

// The harness's own rename: true when Claude Code holds the name (a background job), false when only the store can.
export const rename = ({ deps, task, name }) => renameJob(deps, task.job, name);

export default { id, label, caps, installed, checkStart, start, scan, look, withLast, remote, row, find, facts, read, send, rename };
