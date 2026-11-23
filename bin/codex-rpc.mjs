// Every call herdr-channels makes to Codex's app-server (the `codex app-server` daemon), with no dependencies, as
// bin/cloud.mjs holds every call to Claude Code's sessions API. When Codex changes its protocol, only this file should
// have to change. It has no imports outside Node, so another channels store (a hub) can carry a verbatim copy.
//
// The daemon's control socket ($CODEX_HOME/app-server-control/app-server-control.sock) speaks JSON-RPC (without the
// "jsonrpc" field) inside WebSocket frames over the unix socket; plain JSON lines get no answer. This file does the
// handshake and the framing, `initialize`, and gives `call`, `notify` and an event stream, then one function per
// method channels uses (below `connect`).
//
//   import { connect, readThread } from './codex-rpc.mjs';
//   const c = await connect({ socket });          // socket defaults to the daemon's control socket
//   const thread = await readThread(c, id);
//   c.on((msg) => …);                             // every notification and server request
//   c.respond(id, result);                        // answer a server request (an approval, say)
//   c.close();
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const controlSocket = (codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) =>
  join(codexHome, 'app-server-control', 'app-server-control.sock');

function frame(text) {
  const data = Buffer.from(text);
  const mask = randomBytes(4);
  let head;
  if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, data]);
}

export function connect({ socket = controlSocket(), client = 'herdr-channels', timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: socket });
    const pending = new Map();
    const listeners = new Set();
    let buf = Buffer.alloc(0);
    let open = false;
    let id = 0;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no answer from ${socket}`)); }, timeoutMs);
    const write = (o) => sock.write(frame(JSON.stringify(o)));
    const api = {
      // A call that gets no answer in callMs fails, so a stuck daemon can't hold up whoever asked.
      call: (method, params = {}, { callMs = 20000 } = {}) => new Promise((done, fail) => {
        const n = ++id;
        const t = setTimeout(() => { pending.delete(n); fail(Object.assign(new Error(`${method}: no answer in ${callMs / 1000}s`), { rpc: { code: 'timeout' } })); }, callMs);
        t.unref?.();
        pending.set(n, (m) => { clearTimeout(t); if (m.error) fail(Object.assign(new Error(`${method}: ${m.error.message}`), { rpc: m.error })); else done(m.result); });
        write({ id: n, method, params });
      }),
      notify: (method, params) => write(params === undefined ? { method } : { method, params }),
      respond: (reqId, result) => write({ id: reqId, result }),
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      close: () => { sock.end(); sock.destroy(); },
      socket,
    };
    sock.on('connect', () => sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('error', (e) => { clearTimeout(timer); if (!open) reject(e); else for (const fn of listeners) fn({ method: 'socket/error', params: { message: e.message } }); });
    sock.on('close', () => { for (const [, done] of pending) done({ error: { message: 'socket closed' } }); pending.clear(); });
    sock.on('data', async (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const status = buf.subarray(0, end).toString().split('\r\n')[0];
        if (!/ 101 /.test(status)) { clearTimeout(timer); sock.destroy(); reject(new Error(`handshake refused: ${status}`)); return; }
        open = true;
        buf = buf.subarray(end + 4);
        try {
          await api.call('initialize', { clientInfo: { name: client, version: '0' }, capabilities: { experimentalApi: true } });
          api.notify('initialized');
          clearTimeout(timer);
          resolve(api);
        } catch (e) { clearTimeout(timer); reject(e); }
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 9) { sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); continue; }
        if (op === 8) { sock.end(); return; }
        if (op !== 1) continue;
        let m; try { m = JSON.parse(payload.toString()); } catch { continue; }
        if (m.id != null && !m.method && pending.has(m.id)) { const done = pending.get(m.id); pending.delete(m.id); done(m); continue; }
        for (const fn of listeners) fn(m);
      }
    });
  });
}

// ---------- the methods channels uses ----------

// A message as Codex takes it: one text input.
export const textInput = (text) => [{ type: 'text', text, text_elements: [] }];

// A new thread with its settings (cwd, sandbox, approvalPolicy, approvalsReviewer, model, developerInstructions,
// config): the thread keeps them, so a later turn passes none. Answers the thread ({ id, path, status, … }).
export const startThread = async (c, params) => (await c.call('thread/start', params)).thread;
export const setThreadName = (c, threadId, name) => c.call('thread/name/set', { threadId, name });
export const startTurn = (c, threadId, text) => c.call('turn/start', { threadId, input: textInput(text) });
// A thread with its status ({ type: 'idle' | 'active' | 'notLoaded' | 'systemError', activeFlags }), name, cwd,
// updatedAt and session file (`path`), without its turns.
export const readThread = async (c, threadId) => (await c.call('thread/read', { threadId })).thread;
// Loads a thread the daemon unloaded, and subscribes this connection to it: a pending approval is sent to it again.
export const resumeThread = async (c, threadId) => (await c.call('thread/resume', { threadId })).thread;
// A message that runs once the current turn ends. Codex wants an id of the client's own for each one.
export const queueMessage = (c, threadId, text) => c.call('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: textInput(text) });
export const queuedMessages = async (c, threadId) => (await c.call('thread/queue/list', { threadId })).data ?? [];
export const listThreads = async (c, params = {}) => (await c.call('thread/list', params)).data ?? [];

// The requests a thread waits on the user for, which Codex sends to a client that subscribes to it (resumeThread),
// also to one that connects after the request was made. Collected for up to `ms` after subscribing; nothing is
// answered. Answers [{ id, method, params }].
export const APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
export async function waitingRequests(c, threadId, { ms = 1500 } = {}) {
  const got = [];
  let wake = null;
  const off = c.on((m) => {
    if (m.id == null || !m.method || !APPROVAL_METHODS.includes(m.method)) return;
    if (m.params?.threadId && m.params.threadId !== threadId) return;
    got.push({ id: m.id, method: m.method, params: m.params ?? {} });
    wake?.();
  });
  try {
    await resumeThread(c, threadId);
    if (!got.length) await new Promise((r) => { wake = r; setTimeout(r, ms).unref?.(); });
    await new Promise((r) => setTimeout(r, 50)); // others replayed in the same breath
    return got;
  } finally { off(); }
}

// Answers an approval request: 'accept' or 'decline' (a command, or a file change).
export const answerApproval = (c, request, decision) => c.respond(request.id, { decision });
