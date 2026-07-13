// A partially-written trailing JSONL record must be re-read on the next
// invocation, never skipped past and lost.
import { makeWorkspace, callHook, tokenCount, compacted, assert, readState, writeFileSync, appendFileSync } from './helpers.mjs';

const ws = makeWorkspace('partial');

writeFileSync(ws.transcript, tokenCount(10000));
callHook(ws, 'PostToolUse'); // init at EOF

// append HALF of a compaction record, no trailing newline
const full = compacted();
appendFileSync(ws.transcript, full.slice(0, 25));
callHook(ws, 'PostToolUse');
assert(readState(ws).compactions === 0, 'partial record not counted');

// complete the record (+ a following event so there is a trailing newline)
appendFileSync(ws.transcript, full.slice(25) + tokenCount(11000));
callHook(ws, 'PostToolUse');
assert(readState(ws).compactions === 1, 'completed record counted exactly once');

console.log('partial-line: PASS');
