#!/usr/bin/env node
// A stand-in for the `codex` program, for a Codex chat's tests: `codex --version`; `codex app-server --listen
// unix://<socket> -c …` runs test/fake-codex.mjs on that socket until it is stopped; `codex --remote unix://<socket>
// resume <thread>` (the chat's TUI) records what it was given and ends at once. Each call is logged to
// $FAKE_CODEX_LOG as one JSON line { args, env }.
import { appendFileSync } from 'node:fs';
import { fakeCodex } from './fake-codex.mjs';

const args = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(o)}\n`); };
log({ args, env: { CHANNELS_CHANNEL: process.env.CHANNELS_CHANNEL ?? null, CHANNELS_DIR: process.env.CHANNELS_DIR ?? null, CHANNELS_NODE: process.env.CHANNELS_NODE ?? null, CHANNELS_SCRIPT: process.env.CHANNELS_SCRIPT ?? null } });
if (args[0] === '--version') { console.log('codex-cli 0.171.0'); process.exit(0); }
if (args[0] === 'app-server') {
  const socket = args[args.indexOf('--listen') + 1].replace(/^unix:\/\//, '');
  const fake = await fakeCodex({ socket, codexHome: process.env.CODEX_HOME });
  // The threads made here, for the test to read once the server is stopped.
  const end = async () => {
    if (process.env.FAKE_CODEX_THREADS) appendFileSync(process.env.FAKE_CODEX_THREADS, `${JSON.stringify([...fake.threads.values()].map((t) => ({ id: t.id, name: t.name, params: t.params, resumed: t.resumed })))}\n`);
    await fake.close();
    process.exit(0);
  };
  process.on('SIGTERM', end);
  process.on('SIGINT', end);
} else if (args[0] === '--remote') {
  process.exit(Number(process.env.FAKE_CODEX_TUI_EXIT ?? 0));
} else process.exit(2);
