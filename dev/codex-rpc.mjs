// A small client for Codex's app-server (the `codex app-server` daemon), with no dependencies.
//
// The daemon's control socket ($CODEX_HOME/app-server-control/app-server-control.sock) speaks JSON-RPC (without the
// "jsonrpc" field) inside WebSocket frames over the unix socket; plain JSON lines get no answer. This file does the
// handshake and the framing, `initialize`, and gives `call`, `notify` and an event stream.
//
//   import { connect } from './codex-rpc.mjs';
//   const c = await connect({ socket });          // socket defaults to the daemon's control socket
//   const r = await c.call('thread/list', {});
//   c.on((msg) => …);                             // every notification and server request
//   c.respond(id, result);                        // answer a server request (an approval, say)
//   c.close();
import net from 'node:net';
import { randomBytes } from 'node:crypto';
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

export function connect({ socket = controlSocket(), client = 'herdr-channels-dev', timeoutMs = 10000 } = {}) {
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
      call: (method, params = {}) => new Promise((done, fail) => {
        const n = ++id;
        pending.set(n, (m) => (m.error ? fail(Object.assign(new Error(`${method}: ${m.error.message}`), { rpc: m.error })) : done(m.result)));
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
