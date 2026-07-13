// One real reset emits multiple compaction-shaped records at the same instant
// (observed in production rollouts: 'compacted' + 'context_compacted' pairs).
// They must count as ONE compaction; a later reset must still count.
import { makeWorkspace, callHook, tokenCount, compacted, assert, readState, writeFileSync, appendFileSync } from './helpers.mjs';

const ws = makeWorkspace('doublecompact');

writeFileSync(ws.transcript, tokenCount(10000));
callHook(ws, 'PostToolUse'); // init

const now = new Date();
appendFileSync(ws.transcript, compacted(now, 'compacted') + compacted(now, 'context_compacted'));
callHook(ws, 'PostToolUse');
assert(readState(ws).compactions === 1, 'same-instant duplicate records counted once');

appendFileSync(ws.transcript, compacted(new Date(now.getTime() + 60000)));
callHook(ws, 'PostToolUse');
assert(readState(ws).compactions === 2, 'a genuinely later reset still counts');

console.log('double-compaction: PASS');
