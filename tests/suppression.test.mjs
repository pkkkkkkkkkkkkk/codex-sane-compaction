// When the native token_budget reminder has fired, the hook's fallback nag
// stands down for that cycle. SessionStart always issues the marker note.
import { makeWorkspace, callHook, tokenCount, assert, writeFileSync, appendFileSync, SID8 } from './helpers.mjs';

const ws = makeWorkspace('suppress-native');

writeFileSync(ws.transcript, tokenCount(10000));
callHook(ws, 'PostToolUse'); // init

appendFileSync(ws.transcript,
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Only 45000 tokens remain before a summary-free context reset. Write your checkpoint file NOW.' }] } }) + '\n'
  + tokenCount(185000));
assert(callHook(ws, 'PostToolUse') === '', 'nag suppressed when native reminder already fired');

const ss = callHook(ws, 'SessionStart');
assert(ss.includes(`Your session marker is ${SID8}`), 'SessionStart issues the marker');
assert(!ss.includes('NOT yours'), 'no disown warning in a clean workspace');

for (const [name, record] of [
  ['user-echo', { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'TOKEN-BUDGET-REMINDER: 45000 tokens remain before a summary-free context reset.' },
  ] } }],
  ['tool-echo', { type: 'response_item', payload: { type: 'custom_tool_call_output', output: [
    { type: 'text', text: 'TOKEN-BUDGET-REMINDER: 45000 tokens remain before a summary-free context reset.' },
  ] } }],
]) {
  const echoWs = makeWorkspace(`suppress-${name}`);
  writeFileSync(echoWs.transcript, tokenCount(10000));
  callHook(echoWs, 'PostToolUse');
  appendFileSync(echoWs.transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n'
    + tokenCount(185000));
  assert(callHook(echoWs, 'PostToolUse').includes('precompaction-hook'), `${name} does not suppress fallback nag`);
}

console.log('suppression: PASS');
