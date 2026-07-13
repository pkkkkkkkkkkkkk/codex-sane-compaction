import { writeFileSync, appendFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const testsDir = dirname(fileURLToPath(import.meta.url));
export const hookPath = join(testsDir, '..', 'hook', 'codex-precompaction-hook.mjs');
export const watcherPath = join(testsDir, '..', 'extras', 'truncation-alert.mjs');

export function makeWorkspace(name) {
  const cwd = join(testsDir, '.tmp', name);
  const transcript = join(testsDir, '.tmp', `${name}-rollout.jsonl`);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(transcript, { force: true });
  mkdirSync(cwd, { recursive: true });
  return { cwd, transcript };
}

export const SID = '01900000-aaaa-bbbb-cccc-ddddeeee1234';
export const SID8 = 'ddddeeee1234';

export function callHook(ws, event, toolInput, sid = SID) {
  const input = JSON.stringify({
    session_id: sid,
    transcript_path: ws.transcript,
    cwd: ws.cwd,
    hook_event_name: event,
    tool_name: 'shell',
    tool_input: toolInput ?? { command: 'git status' },
    trigger: 'auto',
  });
  return execFileSync('node', [hookPath], { input, encoding: 'utf8' });
}

export const tokenCount = (inputTokens, window = 200000, ts = new Date()) =>
  JSON.stringify({
    timestamp: ts.toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 500, reasoning_output_tokens: 0 },
      total_token_usage: { total_tokens: 9 },
      model_context_window: window,
    } },
  }) + '\n';

export const compacted = (ts = new Date(), type = 'compacted') =>
  JSON.stringify({ timestamp: ts.toISOString(), type, payload: {} }) + '\n';

export function readState(ws, sid = SID) {
  return JSON.parse(readFileSync(join(ws.cwd, '.codex-precompaction', '.state', `${sid}.json`), 'utf8'));
}

export function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exit(1); }
  console.log(`  ok: ${msg}`);
}

export { writeFileSync, appendFileSync, mkdirSync, join };
