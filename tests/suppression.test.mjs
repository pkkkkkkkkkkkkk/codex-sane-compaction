// When the native token_budget reminder has fired, the hook's fallback nag
// stands down for that cycle. SessionStart always issues the marker note.
import { makeWorkspace, callHook, tokenCount, assert, writeFileSync, appendFileSync, SID8 } from './helpers.mjs';

const ws = makeWorkspace('suppress');

writeFileSync(ws.transcript, tokenCount(10000));
callHook(ws, 'PostToolUse'); // init

appendFileSync(ws.transcript,
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ text: 'TOKEN-BUDGET-REMINDER: 45000 tokens remain...' }] } }) + '\n'
  + tokenCount(185000));
assert(callHook(ws, 'PostToolUse') === '', 'nag suppressed when native reminder already fired');

const ss = callHook(ws, 'SessionStart');
assert(ss.includes(`Your session marker is ${SID8}`), 'SessionStart issues the marker');
assert(!ss.includes('NOT yours'), 'no disown warning in a clean workspace');

console.log('suppression: PASS');
