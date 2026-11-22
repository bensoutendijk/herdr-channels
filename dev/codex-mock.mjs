// A scripted stand-in for the OpenAI Responses API, so a sandbox Codex runs turns with no account and no cost.
// `dev/sandbox up --codex mock` starts it and points Codex at it (model_provider "mock" in the sandbox config.toml).
//
//   node dev/codex-mock.mjs <port> <log file>
//
// The last user message decides the turn:
//   "SLEEP <n>"   a shell call `sleep <n>`, then (after its output) a final message
//   "ASK"         a final message that ends with a question and numbered options
//   "TOUCH <f>"   a shell call writing a file, asking for escalation (so an approval prompt shows)
//   anything else "ok: <text>"
// Every request is logged with its developer messages, so tests can see what reached the model.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 18431);
const LOG = process.argv[3] || '/dev/stderr';
const log = (s) => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
let n = 0;
const sse = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : '');

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }], models: [] }));
      log(`GET ${req.url}`);
      return;
    }
    let j = {};
    try { j = JSON.parse(body); } catch { /* not JSON */ }
    const input = Array.isArray(j.input) ? j.input : [];
    const last = input[input.length - 1] ?? {};
    const tools = (j.tools ?? []).map((t) => t.name ?? t.type).join(',');
    const said = textOf([...input].reverse().find((x) => x.role === 'user')?.content);
    log(`POST ${req.url} items=${input.length} last=${last.type}/${last.role ?? ''} tools=[${tools}] user=${JSON.stringify(said.slice(-200))}`);
    if (j.instructions) log(`  instructions(${j.instructions.length}): ${JSON.stringify(j.instructions.slice(0, 120))}`);
    const dev = input.filter((x) => x.role === 'developer').map((x) => textOf(x.content)).join(' | ');
    if (dev) log(`  developer: ${JSON.stringify(dev.slice(0, 2000))}`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `resp_${++n}`;
    sse(res, { type: 'response.created', response: { id } });
    const msg = (text) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text, annotations: [] }] });
    const shell = (cmd, escalate) => {
      const name = (j.tools ?? []).some((t) => t.name === 'exec_command') ? 'exec_command' : 'shell';
      const args = name === 'exec_command'
        ? { cmd, yield_time_ms: 60000, ...(escalate ? { sandbox_permissions: 'require_escalated', justification: 'Write the file' } : {}) }
        : { command: ['bash', '-lc', cmd] };
      return { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) };
    };
    let item;
    if (last.type === 'function_call_output') item = msg(`Finished. The command said: ${textOf(last.output) || JSON.stringify(last.output).slice(0, 200)}`);
    else if (/SLEEP (\d+)/.test(said)) item = shell(`sleep ${/SLEEP (\d+)/.exec(said)[1]} && echo slept`);
    else if (/TOUCH (\S+)/.test(said)) item = shell(`echo hi > ${/TOUCH (\S+)/.exec(said)[1]} && echo wrote`, true);
    else if (/ASK/.test(said)) item = msg('I need a decision before I go on. Which colour should the logo use?\n\n1. Teal\n2. Coral\n3. Ink');
    else item = msg(`ok: ${said.slice(-300)}`);
    sse(res, { type: 'response.output_item.done', item });
    sse(res, { type: 'response.completed', response: { id, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } });
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => log(`listening on ${PORT}`));
