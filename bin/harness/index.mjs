// The harnesses: the coding agents a task can run on. One module per harness, each the same shape (docs/harnesses.md
// §2): its id and label, `caps` (what the mod and the chat's prompt may offer for it), and plain functions that start,
// look at, read, message and rename its sessions. bin/channels.mjs keeps the store and every rule about events and
// cards; what differs between agents is here.
//
// A task records its harness (`harness` in the store); a task without one is Claude Code's, as every task was before
// there were harnesses.
import claude from './claude.mjs';
import codex from './codex.mjs';

export const HARNESSES = { claude, codex };
export const DEFAULT_HARNESS = 'claude';

export const harnessId = (t) => t?.harness || DEFAULT_HARNESS;
// The task's harness module, or null for one this command doesn't know (a newer store's): such a task is listed with
// what the store kept, and has no events.
export const harnessOf = (t) => HARNESSES[harnessId(t)] ?? null;
