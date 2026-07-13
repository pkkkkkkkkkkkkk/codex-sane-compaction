// Full nag + gate lifecycle, including the proof-of-read gate and its denial cap.
import { makeWorkspace, callHook, tokenCount, compacted, assert, writeFileSync, appendFileSync, mkdirSync, join, SID8 } from './helpers.mjs';

const ws = makeWorkspace('lifecycle');

writeFileSync(ws.transcript, tokenCount(10000));
assert(callHook(ws, 'PostToolUse') === '', 'init at EOF is silent');

appendFileSync(ws.transcript, tokenCount(120000));
assert(callHook(ws, 'PostToolUse') === '', '60% fill is silent');
assert(callHook(ws, 'PreToolUse') === '', 'pre before any compaction is silent');

appendFileSync(ws.transcript, tokenCount(184000));
assert(callHook(ws, 'PostToolUse').includes('write a checkpoint'), '92% fill nags');
assert(callHook(ws, 'PostToolUse') === '', 'nag is latched');

appendFileSync(ws.transcript, compacted());
const warn = callHook(ws, 'PreToolUse');
assert(warn.includes('no checkpoint file exists') && !warn.includes('"deny"'), 'no artifact: warn, not deny');
assert(callHook(ws, 'PreToolUse') === '', 'warn is latched');

appendFileSync(ws.transcript, tokenCount(185000));
assert(callHook(ws, 'PostToolUse').includes('write a checkpoint'), 'cycle-2 nag re-arms');

mkdirSync(join(ws.cwd, '.codex-precompaction'), { recursive: true });
writeFileSync(join(ws.cwd, '.codex-precompaction', `PRECOMPACTION_${SID8}_2.md`), '# ckpt\n');
appendFileSync(ws.transcript, compacted(new Date(Date.now() + 10000)));

assert(callHook(ws, 'PreToolUse').includes('"permissionDecision":"deny"'), 'first unrelated call denied');
assert(callHook(ws, 'PreToolUse').includes('"permissionDecision":"deny"'), 'second unrelated call denied (no latch on deny)');
assert(callHook(ws, 'PreToolUse', { command: `cat .codex-precompaction/PRECOMPACTION_${SID8}_2.md` }) === '',
  'checkpoint-targeting call allowed through');
assert(callHook(ws, 'PostToolUse', { command: `cat .codex-precompaction/PRECOMPACTION_${SID8}_2.md` }) === '',
  'completed checkpoint read records proof silently');
assert(callHook(ws, 'PreToolUse') === '', 'gate released after verified read');

// denial cap: next cycle, model never reads -> two denies then warn-and-allow
appendFileSync(ws.transcript, compacted(new Date(Date.now() + 60000)));
assert(callHook(ws, 'PreToolUse').includes('"deny"'), 'cycle-3 deny 1');
assert(callHook(ws, 'PreToolUse').includes('"deny"'), 'cycle-3 deny 2');
const capMsg = callHook(ws, 'PreToolUse');
assert(capMsg.includes('Proceeding without a verified checkpoint read') && !capMsg.includes('"deny"'),
  'denial cap: warn-and-allow after 2 denies');
assert(callHook(ws, 'PreToolUse') === '', 'latched after cap');

console.log('lifecycle: PASS');
