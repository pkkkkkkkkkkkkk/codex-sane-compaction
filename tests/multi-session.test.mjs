// Two sessions sharing one workspace must not cross-contaminate: each session's
// gate points only at its own checkpoints, and SessionStart disowns foreign ones.
import { makeWorkspace, callHook, tokenCount, compacted, assert, writeFileSync, appendFileSync, mkdirSync, join } from './helpers.mjs';

const SID_A = '01900000-aaaa-bbbb-cccc-aaaaaaaaaaaa';
const SID_B = '01900000-aaaa-bbbb-cccc-bbbbbbbbbbbb';
const ws = makeWorkspace('multisession');
const dir = join(ws.cwd, '.codex-precompaction');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'PRECOMPACTION_aaaaaaaaaaaa_1.md'), 'session A checkpoint');

// session B starting in the same workspace: A's files are foreign
const ss = callHook(ws, 'SessionStart', undefined, SID_B);
assert(ss.includes('marker is bbbbbbbbbbbb') && ss.includes('NOT yours'), 'B is told A\'s checkpoints are not its own');

// session B compacts with no checkpoint of its own: warn (newestArtifact must not match A's file)
const wsB = { cwd: ws.cwd, transcript: ws.transcript };
writeFileSync(wsB.transcript, tokenCount(10000));
callHook(wsB, 'PostToolUse', undefined, SID_B); // init
appendFileSync(wsB.transcript, compacted());
const gate = callHook(wsB, 'PreToolUse', undefined, SID_B);
assert(gate.includes('no checkpoint file exists') && !gate.includes('"deny"'),
  'B\'s gate ignores A\'s checkpoint (warn, not deny pointing at foreign file)');

console.log('multi-session: PASS');
