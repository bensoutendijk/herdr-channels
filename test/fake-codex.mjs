// A stand-in for Codex's app-server daemon, for the tests: the WebSocket framing over a unix socket, and the methods
// channels calls (bin/codex-rpc.mjs), with threads whose session files it writes the way Codex does. A turn's brief
// decides it:
//   "ASK …"      ends asking a question with options          "APPROVE …"  waits on a command approval
//   "WORK …"     stays working until finish(id)                anything else finishes with "ok: <text>"
// An approval is sent to every client that subscribes (thread/resume), also one that connects later, as Codex does;
// accept runs it and finishes the turn, decline finishes it without.
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function fakeCodex({ socket, codexHome, hooks = [] }) {
  const threads = new Map();
  const calls = [];
  const clients = new Set();
  let reqId = 900;
  const now = () => Math.floor(Date.now() / 1000);
  const line = (th, type, payload) => appendFileSync(th.path, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
  const finishTurn = (th, text) => {
    line(th, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    line(th, 'event_msg', { type: 'task_complete', last_agent_message: text });
    th.status = { type: 'idle' };
    th.updatedAt = now();
    th.pending = null;
    // A queued message runs next, as its own turn.
    const next = th.queue.shift();
    if (next) turn(th, next.text);
  };
  const turn = (th, text) => {
    line(th, 'event_msg', { type: 'task_started' });
    line(th, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    th.updatedAt = now();
    if (/ASK/.test(text)) return finishTurn(th, 'I need a decision before I go on.\n\nWhich colour should the logo use?\n\n1. Teal\n2. Coral\n3. Ink');
    if (/APPROVE/.test(text)) {
      line(th, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{}' });
      th.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
      th.pending = { method: 'item/commandExecution/requestApproval', params: { threadId: th.id, itemId: 'call_1', reason: 'Check the link works', command: "/bin/zsh -lc 'curl -sI https://example.com'", availableDecisions: ['accept', 'decline'] } };
      for (const c of clients) if (c.subs.has(th.id)) offer(c, th);
      return null;
    }
    if (/WORK/.test(text)) { th.status = { type: 'active', activeFlags: [] }; return null; }
    return finishTurn(th, `ok: ${text}`);
  };
  const offer = (c, th) => {
    const id = ++reqId;
    c.asked.set(id, th.id);
    c.send({ id, method: th.pending.method, params: th.pending.params });
  };
  const view = (th) => ({ id: th.id, name: th.name, cwd: th.cwd, path: th.path, status: th.status, updatedAt: th.updatedAt, source: 'vscode', turns: [] });
  const handle = (c, m) => {
    calls.push({ method: m.method ?? `reply:${m.id}`, params: m.params ?? m.result ?? null });
    if (!m.method && m.id != null && c.asked.has(m.id)) {
      const th = threads.get(c.asked.get(m.id));
      c.asked.delete(m.id);
      if (th?.pending) {
        const ok = m.result?.decision === 'accept';
        line(th, 'response_item', { type: 'function_call_output', output: ok ? 'HTTP/2 200' : 'declined' });
        finishTurn(th, ok ? 'The link works: HTTP/2 200.' : 'I left the link unchecked: the request was declined.');
      }
      return;
    }
    const reply = (result) => c.send({ id: m.id, result });
    const err = (message) => c.send({ id: m.id, error: { code: -32600, message } });
    const p = m.params ?? {};
    const th = p.threadId ? threads.get(p.threadId) : null;
    switch (m.method) {
      case 'initialize': return reply({ userAgent: 'fake-codex' });
      case 'initialized': return null;
      case 'thread/start': {
        const id = randomUUID();
        const day = join(codexHome, 'sessions', '2026', '11', '22');
        mkdirSync(day, { recursive: true });
        const t = { id, name: null, cwd: p.cwd, path: join(day, `rollout-2026-11-22T10-00-00-${id}.jsonl`), status: { type: 'idle' }, updatedAt: now(), queue: [], pending: null, params: p, injected: [], resumed: [] };
        writeFileSync(t.path, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: p.cwd } })}\n`);
        threads.set(id, t);
        return reply({ thread: view(t) });
      }
      case 'thread/name/set': if (!th) return err('no such thread'); th.name = p.name; return reply({});
      case 'thread/settings/update': if (!th) return err('no such thread'); th.settings = { ...(th.settings ?? {}), ...p }; return reply({});
      case 'thread/read': return th ? reply({ thread: view(th) }) : err(`thread not found: ${p.threadId}`);
      case 'thread/list': return reply({ data: [...threads.values()].map(view), nextCursor: null });
      case 'thread/resume':
        if (!th) return err('no such thread');
        if (th.status.type === 'notLoaded') th.status = { type: 'idle' };
        th.resumed.push(p);
        c.subs.add(th.id);
        reply({ thread: view(th) });
        if (th.pending) offer(c, th);
        return null;
      case 'turn/start': if (!th) return err('no such thread'); turn(th, p.input?.[0]?.text ?? ''); return reply({ turn: { id: randomUUID() } });
      case 'thread/queue/add':
        if (!th) return err('no such thread');
        if (!p.clientUserMessageId) return err('missing field `clientUserMessageId`');
        th.queue.push({ id: p.clientUserMessageId, text: p.input?.[0]?.text ?? '' });
        return reply({});
      case 'thread/queue/list': return th ? reply({ data: th.queue }) : err('no such thread');
      case 'thread/inject_items': if (!th) return err('no such thread'); th.injected.push(...(p.items ?? [])); return reply({});
      // The hooks as a chat's server lists them: `hooks` given by the test, each { command, trustStatus }.
      case 'hooks/list': return reply({ data: [{ cwd: '/', hooks, warnings: [], errors: [] }] });
      default: return err(`unknown method ${m.method}`);
    }
  };
  const sockets = new Set();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    let open = false;
    const c = {
      subs: new Set(), asked: new Map(),
      send: (o) => {
        const data = Buffer.from(JSON.stringify(o));
        const head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : null;
        if (head && !sock.destroyed) sock.write(Buffer.concat([head, data]));
      },
    };
    clients.add(c);
    sock.on('close', () => clients.delete(c));
    sock.on('error', () => clients.delete(c));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)/.exec(buf.subarray(0, end).toString())[1].trim();
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        open = true;
        buf = buf.subarray(end + 4);
      }
      while (buf.length >= 6) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        if (op === 1) handle(c, JSON.parse(data.toString()));
      }
    });
  });
  await new Promise((done) => srv.listen(socket, done));
  return {
    threads, calls,
    finish: (id, text = 'Done.') => finishTurn(threads.get(id), text),
    unload: (id) => { threads.get(id).status = { type: 'notLoaded' }; },
    close: () => new Promise((done) => { for (const s of sockets) s.destroy(); srv.close(() => done()); }),
  };
}
