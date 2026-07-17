import { writeFileSync, appendFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const testsDir = dirname(fileURLToPath(import.meta.url));
export const hookPath = join(testsDir, '..', 'hook', 'codex-precompaction-hook.mjs');
export const watcherPath = join(testsDir, '..', 'extras', 'truncation-alert.mjs');
const tmpBase = process.env.CODEX_TEST_TMP_ROOT
  ? resolve(process.env.CODEX_TEST_TMP_ROOT)
  : join(testsDir, '.tmp');
const runId = process.env.CODEX_TEST_RUN_ID ?? `direct-${process.pid}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('CODEX_TEST_RUN_ID must be one safe path segment');
}
export const tmpRoot = join(tmpBase, `codex-sane-compaction-${runId}`);

export function makeWorkspace(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    throw new Error('test workspace name must be one safe path segment');
  }
  const cwd = join(tmpRoot, name);
  const transcript = join(tmpRoot, `${name}-rollout.jsonl`);
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
