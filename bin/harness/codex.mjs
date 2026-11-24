// The Codex harness: a task can run on OpenAI's Codex CLI instead of Claude Code (docs/harnesses.md §3).
//
// A Codex task runs in Codex's own background service, the app-server daemon Codex's TUI starts and uses, so it is as
// much a Codex session as one the user started: it shows in `codex resume`, in Codex's other tools and, when the
// daemon is paired, in the Codex app. Every call to that service is in bin/codex-rpc.mjs. When the service can't be
// reached (Codex changed its protocol, the daemon won't start), a task runs in a herdr-core terminal instead
// (terminal mode): `codex` there, its state from Herdr's view of the terminal and its session file.
//
// The same shape as bin/harness/claude.mjs (see bin/harness/index.mjs). It has no imports outside Node and this
// folder's bin/codex-rpc.mjs, so another channels store (a hub) can carry verbatim copies of the two.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as rpc from '../codex-rpc.mjs';

export class HarnessError extends Error {
  constructor(msg) { super(msg); this.name = 'UsageError'; }
}
const fail = (msg) => { throw new HarnessError(msg); };
const oneLine = (s) => `${s ?? ''}`.replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const id = 'codex';
export const label = 'Codex';
// What Codex offers, beside Claude Code's: no Remote Control or cloud tasks, a message to a busy task is queued rather
// than refused, approvals can be answered from outside, and no copies are ever started.
export const caps = {
  rename: true, remoteControl: false, cloud: false, approvals: true, open: true,
  sendWhileWorking: 'queue', question: 'heuristic', copies: false,
};
// A task in terminal mode has less: Herdr types into it, and it has no name or approvals to reach from outside.
export const taskCaps = (t) => (t?.codex?.mode === 'terminal' ? { ...caps, rename: false, approvals: false, sendWhileWorking: 'refuse' } : caps);

// Codex has no way to say a turn ended asking something (outside its Plan mode), so each task is told how to end one:
// with the real model, this caught 9 questions of 9 and no finish (docs/harnesses.md §10). A turn counts as asking when
// its last line ends with "?" or its message ends with a short list of options.
export const QUESTION_RULE = 'If you cannot go on without the user\'s decision or information, stop and make your final message end with that one question as its own last line, ending in a question mark, with nothing after it. Never end a finished task\'s message with a question.';

// channels' --permission-mode, as Codex settings. No mode (or "default") is Codex's own default.
export const MODES = {
  default: { sandbox: 'workspace-write', approval: 'on-request' },
  auto: { sandbox: 'workspace-write', approval: 'on-request', reviewer: 'auto_review' },
  plan: { sandbox: 'read-only', approval: 'on-request' },
  bypassPermissions: { sandbox: 'danger-full-access', approval: 'never' },
};
export function checkStart({ mode = null } = {}) {
  if (mode != null && mode !== '' && !MODES[mode]) fail(`--permission-mode for a Codex task is one of ${Object.keys(MODES).join(', ')} (got "${mode}"). Without it, Codex's own default: workspace-write, asking before it leaves the sandbox.`);
}
const modeOf = (mode) => MODES[mode || 'default'];

// ---------- Codex's records ----------

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const sessionsDir = (deps) => join(deps.codexHome, 'sessions');
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// A session file (rollout-…-<thread id>.jsonl) by thread id, under ~/.codex/sessions/<year>/<month>/<day>.
export function findRollout(deps, threadId) {
  const root = sessionsDir(deps);
  if (!/^[0-9a-f-]{8,64}$/i.test(threadId) || !existsSync(root)) return null;
  const ls = (d) => { try { return readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of ls(root)) for (const m of ls(join(root, y))) for (const d of ls(join(root, y, m))) {
    const hit = ls(join(root, y, m, d)).find((f) => f.endsWith(`${threadId}.jsonl`));
    if (hit) return join(root, y, m, d, hit);
  }
  return null;
}

const ITEM = /^\s*(?:\d{1,2}[.)]|[-*•]|\(?[a-fA-F][.)])\s+(.+?)\s*$/;
// Whether a finished turn's message ends asking the user something: its last line ends with "?", or it ends with a
// list of 2 to 6 short options.
export function endsAsking(text) {
  const lines = `${text ?? ''}`.split('\n').map((l) => l.replace(/\*\*|__|`/g, '').trim()).filter(Boolean);
  if (!lines.length) return false;
  if (/\?["')\]]*$/.test(lines.at(-1))) return true;
  let n = 0;
  while (n < lines.length && ITEM.test(lines[lines.length - 1 - n])) n++;
  return n >= 2 && n <= 6 && n < lines.length && lines.slice(-n).every((l) => ITEM.exec(l)[1].length <= 80);
}
// The question itself: the last line that ends with "?", else the message's end.
const questionOf = (text) => {
  const lines = `${text ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...lines].reverse().find((l) => /\?["')\]]*$/.test(l.replace(/\*\*|__|`/g, ''))) ?? lines.at(-1) ?? null;
};

export const THREAD = { keep: 40, textChars: 1500 };

// A session file as channels reads it: { cwd, thread, last, turns: { started, completed, aborted }, outcome, error }.
// The thread is oldest first, as bin/harness/claude.mjs gives it: { who: 'user' | 'agent', at, text } and
// { who: 'tools', calls }; developer messages and Codex's own context (<environment_context>…) are left out. `last` is
// the last finished turn's message, whole; `outcome` how the last turn ended: 'complete', 'aborted', or null while
// one runs (or none ran).
export function parseRollout(text) {
  const st = { cwd: null, thread: [], last: null, turns: { started: 0, completed: 0, aborted: 0 }, outcome: null, error: null };
  for (const line of `${text ?? ''}`.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // a line being written
    const p = r.payload ?? {};
    const at = r.timestamp ?? null;
    if (r.type === 'session_meta' && p.cwd && !st.cwd) st.cwd = p.cwd;
    if (r.type === 'event_msg') {
      if (p.type === 'task_started') { st.turns.started++; st.outcome = null; }
      else if (p.type === 'task_complete') {
        st.turns.completed++; st.outcome = 'complete'; st.error = p.error ?? null;
        if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) st.last = { at, text: p.last_agent_message.trim() };
      } else if (p.type === 'turn_aborted') { st.turns.aborted++; st.outcome = 'aborted'; }
      continue;
    }
    if (r.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const said = (p.content ?? []).filter((b) => b?.type === 'input_text').map((b) => b.text).join('\n').trim();
      if (!said || said.startsWith('<')) continue;
      st.thread.push({ who: 'user', at, text: said.slice(0, THREAD.textChars) });
    } else if (p.type === 'message' && p.role === 'assistant') {
      const said = (p.content ?? []).filter((b) => b?.type === 'output_text').map((b) => b.text).join('\n').trim();
      if (said) st.thread.push({ who: 'agent', at, text: said.slice(0, THREAD.textChars) });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const prev = st.thread[st.thread.length - 1];
      if (prev?.who === 'tools') prev.calls++; else st.thread.push({ who: 'tools', at, calls: 1 });
    }
  }
  if (st.thread.length > THREAD.keep) st.thread = st.thread.slice(-THREAD.keep);
  return st;
}

const readRollout = (file) => { try { return file ? parseRollout(readFileSync(file, 'utf8')) : null; } catch { return null; } };
const sizeOf = (file) => { try { return statSync(file).size; } catch { return 0; } };

// ---------- the service ----------

function onPath(cmd) {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  for (const d of `${process.env.PATH ?? ''}`.split(':')) if (d && existsSync(join(d, cmd))) return join(d, cmd);
  return null;
}

// A client of Codex's daemon: its control socket, started first when nothing answers there (`codex app-server daemon
// start` is quick when it already runs). Throws when it still can't be reached.
export async function service(deps) {
  const socket = deps.codexSocket || rpc.controlSocket(deps.codexHome);
  try { return await rpc.connect({ socket, timeoutMs: 8000 }); } catch (first) {
    if (deps.codexSocket) throw first; // a socket given by hand is never started here
    const r = await deps.run(deps.codex, ['app-server', 'daemon', 'start'], { cwd: deps.home, timeout: 60_000 });
    if (r.code !== 0) throw new Error(`codex app-server daemon start: ${cut(oneLine(r.err || r.out || `exit ${r.code}`), 200)}`);
    return rpc.connect({ socket, timeoutMs: 8000 });
  }
}

// Codex's version: `codex --version`, remembered for that binary (path, size, mtime) as for Claude Code.
export async function installed({ dir, deps }) {
  const path = onPath(deps.codex);
  if (!path) return null;
  let st;
  const target = real(path);
  try { st = statSync(target); } catch { return null; }
  const key = `${target}:${st.size}:${st.mtimeMs}`;
  const file = join(dir, 'codex-version.json');
  const was = readJson(file);
  if (was?.key === key) return was.version ? { version: was.version } : null;
  const r = await deps.run(deps.codex, ['--version'], { cwd: deps.home, timeout: 20_000 });
  const version = (/(\d+\.\d+\.\d+)/.exec(r.out) || [])[1] ?? null;
  if (version) {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ key, version })}\n`);
      renameSync(tmp, file);
    } catch { /* not remembered */ }
  }
  return version ? { version } : null;
}

// ---------- starting ----------

// A task: a thread in Codex's daemon with the folder, the sandbox and approvals for the mode, the question rule as
// developer instructions and CLAUDE.md as the fallback for AGENTS.md, then its name and its first turn, the brief.
// When the daemon can't be reached, or won't take the thread, the task runs in a terminal instead (terminal mode).
// Answers { session_id, job: null, codex: { mode, sandbox, approval, model, terminal?, why? } }.
export async function start({ deps, cwd, brief, name, model = null, mode = null }) {
  checkStart({ mode });
  const m = modeOf(mode);
  const kept = { sandbox: m.sandbox, approval: m.approval, model: model ?? null };
  let why = null;
  if (deps.codexMode !== 'terminal') {
    let c = null;
    try { c = await service(deps); } catch (err) { why = `Codex's service can't be reached (${cut(oneLine(err.message), 160)})`; }
    if (c) {
      try {
        let thread;
        try {
          thread = await rpc.startThread(c, {
            cwd, sandbox: m.sandbox, approvalPolicy: m.approval, ...(m.reviewer ? { approvalsReviewer: m.reviewer } : {}), ...(model ? { model } : {}),
            developerInstructions: QUESTION_RULE, config: { project_doc_fallback_filenames: ['CLAUDE.md'] },
          });
        } catch (err) { why = `Codex's service didn't take the task (${cut(oneLine(err.message), 160)})`; }
        if (thread?.id) {
          try {
            await rpc.setThreadName(c, thread.id, name);
            await rpc.startTurn(c, thread.id, brief);
          } catch (err) { fail(`Codex started thread ${thread.id} but didn't take its brief: ${cut(oneLine(err.message), 200)}. Send it again with channels send once it is filed (channels file … --harness codex).`); }
          return { session_id: thread.id, job: null, codex: { mode: 'service', ...kept } };
        }
      } finally { c.close(); }
    }
  }
  return startInTerminal({ deps, cwd, brief, name, m, kept, why: why ?? 'terminal mode was asked for (CHANNELS_CODEX_MODE)' });
}

const toml = (s) => JSON.stringify(s); // a TOML basic string is a JSON string
async function startInTerminal({ deps, cwd, brief, name, m, kept, why }) {
  const codex = onPath(deps.codex) ?? deps.codex;
  const term = `codex-${Math.random().toString(16).slice(2, 10)}`;
  const since = Date.now() - 2000;
  const args = [codex, '-s', m.sandbox, '-a', m.approval, '-c', `developer_instructions=${toml(QUESTION_RULE)}`, '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]', ...(kept.model ? ['-m', kept.model] : []), brief];
  const r = await deps.run(deps.hc, ['run', '--bg', '--json', '--no-parent', '--name', term, '--cwd', cwd, '--', ...args], { timeout: 30_000 });
  let address = null;
  try { address = JSON.parse(r.out).address ?? null; } catch { /* below */ }
  if (r.code !== 0 || !address) fail(`${why}, and Codex didn't start in a terminal either: ${cut(oneLine(r.err || r.out || `hc exited ${r.code}`), 240)}`);
  // The thread's id is in the session file Codex writes once the turn starts.
  const want = real(cwd);
  let threadId = null;
  for (let k = 0; k < 60 && !threadId; k++) {
    threadId = newRollout(deps, since, want);
    if (!threadId) await deps.sleep(500);
  }
  if (!threadId) fail(`${why}. Codex runs in terminal ${address}, but its session file didn't appear: file it by hand once it does (channels file <channel> <thread id> --harness codex).`);
  return { session_id: threadId, job: null, codex: { mode: 'terminal', terminal: address, why, ...kept } };
}

// The thread of a session file written since `since` for the folder `cwd`, or null.
function newRollout(deps, since, cwd) {
  const root = sessionsDir(deps);
  const ls = (d) => { try { return readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of ls(root).slice(0, 1)) for (const mo of ls(join(root, y)).slice(0, 1)) for (const d of ls(join(root, y, mo)).slice(0, 2)) {
    for (const f of ls(join(root, y, mo, d))) {
      const file = join(root, y, mo, d, f);
      try { if (statSync(file).mtimeMs < since) continue; } catch { continue; }
      const head = firstLine(file);
      if (head?.type === 'session_meta' && real(head.payload?.cwd ?? '') === cwd && head.payload?.id) return head.payload.id;
    }
  }
  return null;
}
function firstLine(file) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    return JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]);
  } catch { return null; }
}

// An empty task (the panel's New Codex session): the thread with its settings and name, and no turn; you type its first
// message in its view in the panel (`codex resume`). Only over the service: a terminal would need a first message.
export async function startEmpty({ deps, cwd, name, model = null, mode = null }) {
  checkStart({ mode });
  const m = modeOf(mode);
  const c = await service(deps).catch((err) => fail(`Codex's service can't be reached (${cut(oneLine(err.message), 160)}): start a Codex session in a terminal instead.`));
  try {
    const thread = await rpc.startThread(c, {
      cwd, sandbox: m.sandbox, approvalPolicy: m.approval, ...(m.reviewer ? { approvalsReviewer: m.reviewer } : {}), ...(model ? { model } : {}),
      developerInstructions: QUESTION_RULE, config: { project_doc_fallback_filenames: ['CLAUDE.md'] },
    });
    await rpc.setThreadName(c, thread.id, name);
    return { session_id: thread.id, job: null, codex: { mode: 'service', sandbox: m.sandbox, approval: m.approval, model: model ?? null } };
  } finally { c.close(); }
}

// ---------- looking ----------

// One look's shared state: a client of the daemon, opened on the first look at a task that needs it and closed by
// `close()` once the look is over.
export function scan({ deps }) {
  let client = null;
  let tried = null;
  return {
    deps, snaps: new Map(),
    async conn() {
      if (client || tried) return client;
      try { client = await service(deps); } catch (err) { tried = err.message; }
      return client;
    },
    get why() { return tried; },
    close() { try { client?.close(); } catch { /* gone */ } client = null; },
  };
}

const iso = (t) => (Number.isFinite(t) ? new Date(t * (t < 1e12 ? 1000 : 1)).toISOString() : null);
const unknown = (t, why) => ({
  harness: id, sid: t.session_id, st: { state: 'unknown', doing: `State unknown: ${why}` }, kind: null, mark: { kind: null, work: null }, prompt: false,
  waiting: null, needs: null, result: null, detail: null, at: null, kept: t.named === 'user' ? t.name : null, agentName: '', liveWaiting: null, last: null, title: '',
});

// What the listener would say about a Codex task right now (a Snap, as bin/harness/claude.mjs gives): from the
// daemon's status for the thread, its queue, and its session file; for a task in terminal mode, from Herdr's view of
// its terminal and the session file. `work` is the session file's size: it grows with every item the turn does.
//
//   active                  → working (waiting_on_user with a prompt when it waits on an approval)
//   idle with a queued msg  → working: the next turn is about to start, so this is no finish
//   idle / notLoaded        → by its last turn: asking (blocked), complete (done), aborted or failed (failed),
//                             still started (paused: the daemon stopped mid-turn)
//   systemError             → failed
export async function look(sc, t) {
  const sid = t.session_id;
  if (t.codex?.mode === 'terminal') return lookTerminal(sc, t);
  const c = await sc.conn();
  if (!c) return unknown(t, `Codex's service can't be reached (${sc.why})`);
  let th;
  try { th = await rpc.readThread(c, sid); } catch (err) { return unknown(t, `Codex doesn't know thread ${sid} (${cut(oneLine(err.message), 120)})`); }
  const file = th.path || findRollout(sc.deps, sid);
  const roll = readRollout(file);
  const type = th.status?.type ?? 'notLoaded';
  const flags = th.status?.activeFlags ?? [];
  let st;
  let prompt = false;
  if (type === 'active') {
    if (flags.includes('waitingOnApproval')) { st = { state: 'waiting_on_user', doing: 'Waiting on you: an approval' }; prompt = true; }
    else if (flags.includes('waitingOnUserInput')) { st = { state: 'waiting_on_user', doing: 'Waiting on you: a question in Codex' }; prompt = true; }
    else st = { state: 'working', doing: 'Working' };
  } else if (type === 'systemError') st = { state: 'failed', doing: 'Codex reports a system error on this thread' };
  else {
    let queued = [];
    if (type === 'idle') { try { queued = await rpc.queuedMessages(c, sid); } catch { queued = []; } }
    st = queued.length ? { state: 'working', doing: 'A queued message is next' } : byLastTurn(roll, type);
  }
  return snap(t, { sid, st, prompt, roll, file, at: iso(th.updatedAt), agentName: th.name || '' }, sc);
}

function byLastTurn(roll, type) {
  if (!roll || !roll.turns.started) return { state: 'done', doing: 'No turn yet' };
  const t = roll.turns;
  if (roll.outcome == null && t.started > t.completed + t.aborted) {
    return type === 'idle' ? { state: 'working', doing: 'Working' } : { state: 'paused', doing: 'Codex stopped while it was working' };
  }
  if (roll.outcome === 'aborted') return { state: 'failed', doing: 'Its turn was stopped' };
  if (roll.error) return { state: 'failed', doing: `Its turn failed: ${cut(oneLine(typeof roll.error === 'string' ? roll.error : JSON.stringify(roll.error)), 160)}` };
  if (roll.last && endsAsking(roll.last.text)) return { state: 'blocked', doing: questionOf(roll.last.text) ?? 'It asks something' };
  return { state: 'done', doing: 'Done' };
}

function snap(t, { sid, st, prompt, roll, file, at, agentName, terminal = null }, sc) {
  const kind = st.state === 'done' || st.state === 'failed' ? 'done' : st.state === 'waiting_on_user' || st.state === 'blocked' ? 'needs' : null;
  return {
    harness: id, sid, st, kind, mark: { kind, work: sizeOf(file) }, prompt,
    waiting: kind === 'needs' ? (prompt ? st.doing.replace(/^Waiting on you: /, '') : st.doing) : null,
    needs: st.state === 'blocked' ? st.doing : null, result: null, detail: null, at: at ?? null,
    kept: t.named === 'user' && t.name ? t.name : null, agentName, liveWaiting: prompt ? st.doing.replace(/^Waiting on you: /, '') : null,
    last: null, title: '', approval: null, terminal,
    _roll: roll, _sc: sc, _task: t,
  };
}

async function lookTerminal(sc, t) {
  const sid = t.session_id;
  const file = findRollout(sc.deps, sid);
  const roll = readRollout(file);
  let status = null;
  let live = false;
  const r = await sc.deps.run(sc.deps.hc, ['get', t.codex.terminal, '--json'], { timeout: 15_000 });
  try { const j = JSON.parse(r.out); live = j.state === 'live'; status = j.status ?? null; } catch { /* gone */ }
  const state = typeof status === 'string' ? status : status?.state ?? null;
  let st;
  let prompt = false;
  if (live && state === 'blocked') { st = { state: 'waiting_on_user', doing: 'Waiting on you: a prompt in its terminal' }; prompt = true; }
  else if (live && state === 'working') st = { state: 'working', doing: 'Working' };
  else st = byLastTurn(roll, live ? 'idle' : 'notLoaded');
  if (!live && st.state === 'working') st = { state: 'paused', doing: 'Its terminal ended while it was working' };
  return snap(t, { sid, st, prompt, roll, file, at: null, agentName: '', terminal: t.codex.terminal }, sc);
}

// The task's own words for what look saw: its last finished turn's message. For a task waiting on an approval, the
// request itself too (`approval`: what it would run and why), which Codex sends again to a client that subscribes.
export async function withLast(now, lastMark) {
  now.last = now._roll?.last?.text ?? null;
  now.title = now.agentName || '';
  now.mark.last = lastMark(now.last);
  if (now.prompt && !now.terminal && now._sc) {
    const c = await now._sc.conn();
    if (c) {
      try {
        const reqs = await rpc.waitingRequests(c, now.sid);
        const req = reqs.find((x) => x.method !== 'item/tool/requestUserInput') ?? reqs[0];
        if (req) {
          now.approval = approvalOf(req);
          now.waiting = now.approval.summary;
          now.liveWaiting = now.approval.summary;
        }
      } catch { /* the card says less */ }
    }
  }
  return now;
}

// An approval request as a card shows it: what it would run (or change), why, and whether Allow and Deny can answer
// it (a command or a file change; a permissions request is answered in Codex itself).
export function approvalOf(req) {
  const p = req.params ?? {};
  const kind = req.method.includes('commandExecution') ? 'command' : req.method.includes('fileChange') ? 'file_change' : req.method.includes('permissions') ? 'permissions' : 'question';
  const command = typeof p.command === 'string' ? p.command.replace(/^\/bin\/(?:ba|z)?sh -lc '([\s\S]*)'$/, '$1') : null;
  const reason = typeof p.reason === 'string' && p.reason.trim() ? oneLine(p.reason) : null;
  const what = kind === 'command' ? `Run: ${cut(oneLine(command ?? 'a command'), 200)}` : kind === 'file_change' ? 'Change files' : kind === 'permissions' ? 'More permissions' : 'An answer in Codex';
  return { kind, command, reason, answerable: kind === 'command' || kind === 'file_change', summary: reason ? `${what} (${cut(reason, 200)})` : what };
}

// The card's extra fields for an approval: Allow and Deny when the request takes them.
export const approvalCard = (a) => ({ state: a.answerable ? 'approval' : 'prompt', command: a.command ? cut(a.command, 400) : null, reason: a.reason, approval: a.kind });

// One task as `channels list` shows it: its name as Codex has it (unless the user renamed it here), and its standing
// from the look `list` took first (sc.snaps).
export function row(sc, t) {
  const now = sc?.snaps?.get(t.session_id) ?? null;
  const name = t.named === 'user' && t.name ? t.name : now?.agentName || t.name || '';
  const standing = !now ? null : now.kind === 'needs' ? 'needs' : now.st.state === 'working' || now.st.state === 'waiting_on_job' ? 'working' : now.st.state === 'unknown' ? null : 'ready';
  return { session_id: t.session_id, name, remote_url: null, standing, state: now?.st.state ?? null };
}

// A thread by its id, or the start of one (6 or more characters) among the daemon's recent threads.
export async function find({ deps, id: want, machine }) {
  const c = await service(deps).catch((err) => fail(`Codex's service can't be reached to find ${want}: ${err.message}`));
  try {
    let th = null;
    try { th = await rpc.readThread(c, want); } catch { /* not a whole id */ }
    if (!th && want.length >= 6) {
      const hits = (await rpc.listThreads(c, { limit: 100 })).filter((x) => x.id.toLowerCase().startsWith(want.toLowerCase()));
      if (hits.length > 1) fail(`"${want}" matches ${hits.length} Codex threads; use a whole thread id.`);
      th = hits[0] ?? null;
    }
    if (!th) fail(`No Codex thread ${want} on ${machine}.`);
    return { session_id: th.id, job: null, name: th.name || '', cwd: th.cwd || null };
  } finally { c.close(); }
}

// A task's state and its latest messages, as `channels read` shows them.
export async function read({ deps, task, machine, limit }) {
  const sc = scan({ deps });
  try {
    const now = await look(sc, task);
    await withLast(now, () => null);
    const roll = now._roll;
    const thread = roll?.thread ?? [];
    const lastAt = thread.map((x) => x.who).lastIndexOf('agent');
    const messages = thread.slice(-limit).map((x, i, a) => (x.who === 'agent' && thread.length - a.length + i === lastAt && roll?.last ? { ...x, text: roll.last.text } : x));
    return {
      summary: {
        id: task.session_id, machine, job: null, title: now.kept || now.agentName || task.name || '', state: now.st.state, doing: now.st.doing,
        project: null, folder: task.folder ?? roll?.cwd ?? null, waiting_on: now.kind === 'needs' ? now.waiting : null,
        result: null, last_agent_message: now.last, remote_url: null, harness: id,
        ...(now.approval ? { approval: { kind: now.approval.kind, command: now.approval.command, reason: now.approval.reason } } : {}),
      },
      messages: messages.reverse(), more: thread.length > limit,
    };
  } finally { sc.close(); }
}

// A message to a task. Its turn over: a new turn (the thread loaded first when the daemon unloaded it). Working: queued,
// to run once the turn ends. Waiting on an approval: refused, since the approval comes first. In terminal mode it is
// typed into the terminal when the task is idle. Answers { delivered_as: 'resumed' | 'queued' }.
export async function send({ deps, task, body, machine }) {
  const ref = `${machine}/${task.session_id}`;
  if (task.codex?.mode === 'terminal') {
    const sc = scan({ deps });
    const now = await lookTerminal(sc, task);
    if (now.st.state === 'working') fail(`${ref} is working. Send it after it finishes; or type into it in its view in the panel.`);
    if (now.prompt) fail(`${ref} is showing a prompt: answer it in its view in the panel.`);
    if (now.st.state === 'paused' || !now.terminal) fail(`${ref}'s terminal has ended: open it in the panel to resume it there.`);
    const r = await deps.run(deps.hc, ['send', task.codex.terminal, body], { timeout: 60_000 });
    if (r.code !== 0) fail(`Couldn't type into ${ref}'s terminal: ${cut(oneLine(r.err || r.out || `hc exited ${r.code}`), 200)}`);
    return { delivered_as: 'resumed' };
  }
  const c = await service(deps).catch((err) => fail(`Codex's service can't be reached: ${err.message}`));
  try {
    let th = await rpc.readThread(c, task.session_id).catch((err) => fail(`Codex doesn't know ${ref}: ${err.message}`));
    const flags = th.status?.activeFlags ?? [];
    if (th.status?.type === 'active' && flags.includes('waitingOnApproval')) fail(`${ref} is waiting on an approval: answer it first (Allow or Deny on its card, \`channels approve ${ref} allow|deny\`, or in its view in the panel).`);
    if (th.status?.type === 'notLoaded') th = await rpc.resumeThread(c, task.session_id);
    if (th.status?.type === 'active') {
      await rpc.queueMessage(c, task.session_id, body);
      return { delivered_as: 'queued' };
    }
    await rpc.startTurn(c, task.session_id, body);
    return { delivered_as: 'resumed' };
  } finally { c.close(); }
}

// Answers the approval a task waits on: decision 'allow' or 'deny'. Codex sends the request again to this client
// when it subscribes; the task's own terminal, if one shows it, clears its prompt by itself.
export async function approve({ deps, task, decision, machine }) {
  const ref = `${machine}/${task.session_id}`;
  if (!taskCaps(task).approvals) fail(`${ref} runs in a terminal: answer its prompt there (open it in the panel).`);
  const c = await service(deps).catch((err) => fail(`Codex's service can't be reached: ${err.message}`));
  try {
    const reqs = await rpc.waitingRequests(c, task.session_id, { ms: 3000 });
    const req = reqs.find((x) => x.method === 'item/commandExecution/requestApproval' || x.method === 'item/fileChange/requestApproval');
    if (!req) fail(reqs.length ? `${ref} waits on something Allow and Deny can't answer (${reqs[0].method}): answer it in its view in the panel.` : `${ref} has no approval waiting.`);
    rpc.answerApproval(c, req, decision === 'allow' ? 'accept' : 'decline');
    await new Promise((r) => setTimeout(r, 300)); // the answer is on its way before the socket closes
    return { answered: approvalOf(req), decision };
  } finally { c.close(); }
}

// Renames the thread in Codex: its TUI, `codex resume` and Codex's list show the name. A task in terminal mode can't
// be renamed from outside: false, and the store keeps the name.
export async function rename({ deps, task, name }) {
  if (task.codex?.mode === 'terminal') return false;
  const c = await service(deps).catch(() => null);
  if (!c) return false;
  try { await rpc.setThreadName(c, task.session_id, name); return true; } catch { return false; } finally { c.close(); }
}

// What shows a task live in a terminal: `codex resume <id>`, which attaches to the daemon's thread (mid-turn too); a
// task in terminal mode is shown in its own terminal (`terminal`).
export const openArgv = (t) => (t.codex?.mode === 'terminal' ? { terminal: t.codex.terminal } : { argv: ['codex', 'resume', t.session_id] });

// ---------- a channel's chat on Codex (docs/harnesses.md §4) ----------
//
// The chat runs a Codex server of its own (`codex app-server --listen unix://<socket>`), with the chat's prompt as
// developer instructions and channels' UserPromptSubmit hook, given as -c settings so they reach that server only and
// never the user's config files. The thread is an ordinary Codex session in the user's Codex home; the user types into
// Codex's own TUI attached to the server (`codex --remote … resume <thread>`), and the listener is another client of the
// same server: notices and routines go in as turns (queued behind one that runs), not typed.

export const chatSocket = (dir, channelId) => join(dir, `codex-${channelId}.sock`);

// The hook's command. Codex asks the user to trust a hook once per command text, so it is the same text for every chat
// and every version of channels: what differs (node, this script, the store, the channel) comes from the environment
// the chat's server runs in (chatEnv).
export const CHAT_HOOK = '"$CHANNELS_NODE" "$CHANNELS_SCRIPT" pending "$CHANNELS_CHANNEL" --hook';
export const chatHookEnv = ({ node, script, dir, channelId }) => ({ CHANNELS_NODE: node, CHANNELS_SCRIPT: script, CHANNELS_DIR: dir, CHANNELS_CHANNEL: channelId });

export const chatServerArgs = ({ socket, prompt }) => [
  'app-server', '--listen', `unix://${socket}`,
  '-c', `developer_instructions=${toml(prompt)}`,
  '-c', `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${toml(CHAT_HOOK)},timeout=10}]}]`,
];
export const chatTuiArgs = ({ socket, threadId }) => ['--remote', `unix://${socket}`, 'resume', threadId];

// A client of the chat's server, once it answers (it takes a moment to start).
export async function chatConnect(socket, { waitMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { return await rpc.connect({ socket, timeoutMs: 5000 }); } catch (err) {
      if (Date.now() >= until) throw err;
      await sleep(250);
    }
  }
}

// The chat's thread: the one recorded, loaded again and given this launch's prompt; else a new one, named #<channel>.
// The client stays subscribed, which keeps the thread loaded until Codex's TUI resumes it. Answers { thread, fresh }.
export async function chatThread(c, { threadId, cwd, prompt, name }) {
  if (threadId) {
    try { return { thread: await rpc.resumeThread(c, threadId, { developerInstructions: prompt }), fresh: false }; } catch { /* never used, or gone: a new one */ }
  }
  const thread = await rpc.startThread(c, { cwd, developerInstructions: prompt });
  await rpc.setThreadName(c, thread.id, name);
  await rpc.resumeThread(c, thread.id).catch(() => null);
  return { thread, fresh: true };
}

// Where the chat's thread stands: 'idle', 'busy' (a turn runs, or one is queued), 'waiting' (on an approval or an
// answer in the TUI), or null when the server can't say.
export async function chatState(c, threadId) {
  let th;
  try { th = await rpc.readThread(c, threadId); } catch { return null; }
  const type = th.status?.type;
  if (type === 'active') return (th.status.activeFlags ?? []).some((f) => /^waitingOn/.test(f)) ? 'waiting' : 'busy';
  if (type === 'idle') {
    try { if ((await rpc.queuedMessages(c, threadId)).length) return 'busy'; } catch { /* none known */ }
    return 'idle';
  }
  return type === 'notLoaded' ? 'idle' : null;
}

// A message into the chat from the listener (a notice, a wake, a routine run): a turn when the chat is idle, queued
// behind the turn that runs otherwise, so it never interrupts an answer and never lands in a half-typed draft. Answers
// 'started' or 'queued'.
export async function chatDeliver(c, threadId, text) {
  let th = await rpc.readThread(c, threadId);
  if (th.status?.type === 'notLoaded') th = await rpc.resumeThread(c, threadId);
  if (th.status?.type === 'active') { await rpc.queueMessage(c, threadId, text); return 'queued'; }
  // Idle with messages queued: they run first, so this goes behind them.
  let queued = [];
  try { queued = await rpc.queuedMessages(c, threadId); } catch { /* none known */ }
  if (queued.length) { await rpc.queueMessage(c, threadId, text); return 'queued'; }
  await rpc.startTurn(c, threadId, text);
  return 'started';
}

// Whether channels' hook is trusted: null when the server doesn't list it.
export async function chatHookTrusted(c) {
  const mine = (await rpc.listHooks(c)).find((h) => h.command === CHAT_HOOK);
  return mine ? mine.trustStatus === 'trusted' : null;
}
export const chatNote = (c, threadId, text) => rpc.injectNote(c, threadId, text);

// Codex's "Hooks need review" prompt on the chat's screen, and whether its cursor is on "Trust all and continue".
export const hookReview = (screen) => /Hooks need review/.test(screen ?? '') && /Trust all and continue/.test(screen ?? '');
export const trustAllSelected = (screen) => `${screen ?? ''}`.split('\n').some((l) => /^\s*›\s*\d+\.\s*Trust all and continue/.test(l));

// What is typed in the chat's prompt (the last `›` line on its screen): '' when it is empty, null when no prompt shows.
// Codex draws a placeholder in an empty prompt ("Ask Codex to do anything", and others), which reads like text; the
// key hint under it ("? for shortcuts") shows only while the prompt is empty, so it tells the two apart.
export function chatDraft(screen) {
  const lines = `${screen ?? ''}`.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^›(?:\s|$)/.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  if (lines.slice(at + 1).some((l) => /\? for shortcuts/.test(l))) return '';
  return lines[at].replace(/^›\s?/, '').trim(); // its first line is enough to tell a draft
}

// The chat's own words, for the judge: its session file read as a task's is.
export function chatRead(deps, threadId) {
  return readRollout(findRollout(deps, threadId));
}

export default {
  id, label, caps, taskCaps, installed, checkStart, start, startEmpty, scan, look, withLast, row, find, read, send, approve, rename, openArgv, approvalCard,
  // the chat
  chatSocket, chatHookEnv, chatServerArgs, chatTuiArgs, chatConnect, chatThread, chatState, chatDeliver, chatHookTrusted, chatNote, hookReview, trustAllSelected, chatDraft, chatRead,
};
