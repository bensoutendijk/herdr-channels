// The dev rig: Codex's app-server client against a stand-in WebSocket server on a unix socket, and the sandbox
// command's guards (it never starts anything here).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../dev/codex-rpc.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// A tiny WebSocket server: answers the handshake, unmasks client frames, replies in unmasked frames.
function fakeServer(path, handle) {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    const send = (o) => {
      const data = Buffer.from(JSON.stringify(o));
      const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      sock.write(Buffer.concat([head, data]));
    };
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
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        handle(JSON.parse(data.toString()), send);
      }
    });
  });
  return new Promise((done) => srv.listen(path, () => done(srv)));
}

test('codex-rpc: handshake, initialize, a call, an error, and a server request answered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const srv = await fakeServer(join(dir, 's.sock'), (m, send) => {
    seen.push(m.method ?? `reply:${m.id}`);
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
    if (m.method === 'thread/list') {
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
      send({ method: 'thread/status/changed', params: { threadId: 'a', status: { type: 'idle' } } });
      send({ id: m.id, result: { data: [{ id: 'a' }] } });
    }
    if (m.method === 'thread/read') send({ id: m.id, error: { code: -32600, message: 'no such thread' } });
  });
  t.after(() => srv.close());
  const c = await connect({ socket: join(dir, 's.sock') });
  const events = [];
  c.on((m) => { events.push(m.method); if (m.id != null) c.respond(m.id, { decision: 'decline' }); });
  assert.deepEqual(await c.call('thread/list'), { data: [{ id: 'a' }] });
  await assert.rejects(c.call('thread/read', { threadId: 'x' }), /thread\/read: no such thread/);
  c.close();
  assert.deepEqual(events, ['item/commandExecution/requestApproval', 'thread/status/changed']);
  assert.deepEqual(seen, ['initialize', 'initialized', 'thread/list', 'reply:900', 'thread/read']);
});

test('dev/sandbox: prints its commands, and refuses a folder it would not own', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [join(repo, 'dev', 'sandbox'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const help = run([]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /dev\/sandbox up \[--codex real\|mock\|none\]/);
  assert.match(help.stdout, /dev\/sandbox down/);
  const deep = run(['up'], { HC_SANDBOX: join(tmpdir(), 'a', 'b') });
  assert.equal(deep.status, 1);
  assert.match(deep.stderr, /one folder right under \/tmp/);
  const none = run(['down'], { HC_SANDBOX: '/private/tmp/hc-no-such-sandbox' });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no sandbox/);
});
