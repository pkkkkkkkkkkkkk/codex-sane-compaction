// Subagent lanes report the PARENT thread id as session_id. The hook must key
// the lane's marker/state/ledgers on the lane's own rollout file id, so a
// lane's compaction can neither steal the parent's next ledger slot nor thrash
// the parent's state file (both observed in production, 2026-07-16).
import { writeFileSync, appendFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, callHook, tokenCount, compacted, SID, SID8, assert } from './helpers.mjs';

const ws = makeWorkspace('lane-isolation');

// Parent transcript: plain rollout, no subagent source.
appendFileSync(ws.transcript, tokenCount(100000));
callHook(ws, 'PostToolUse');

// Parent already wrote checkpoint _3 this cycle.
mkdirSync(join(ws.cwd, '.codex-precompaction'), { recursive: true });
writeFileSync(join(ws.cwd, '.codex-precompaction', `PRECOMPACTION_${SID8}_3.md`), '# parent ckpt');

// Lane transcript: session_meta first line marks it as a spawned subagent, and
// the filename carries the lane's own rollout uuid.
const laneTranscript = join(ws.cwd, '..', 'lane-rollout-019f0000-aaaa-bbbb-cccc-feedface0001.jsonl');
writeFileSync(laneTranscript, JSON.stringify({
  timestamp: new Date().toISOString(),
  type: 'session_meta',
  payload: {
    id: SID, // parent thread id — the collision under test
    source: { subagent: { thread_spawn: { parent_thread_id: SID, agent_nickname: 'TestLane' } } },
  },
}) + '\n');
appendFileSync(laneTranscript, tokenCount(150000));

const laneWs = { cwd: ws.cwd, transcript: laneTranscript };
callHook(laneWs, 'PostToolUse');
callHook(laneWs, 'PreCompact'); // lane compacts

const art = readdirSync(join(ws.cwd, '.codex-precompaction'));
assert(art.includes('PRECOMPACTION_feedface0001_1_ledger.md'),
  'lane ledger uses the lane rollout id, cycle 1');
assert(!art.some(f => f === `PRECOMPACTION_${SID8}_4_ledger.md` || f === `PRECOMPACTION_${SID8}_3_ledger.md`),
  'lane compaction does not consume a parent ledger slot');

const stateFiles = readdirSync(join(ws.cwd, '.codex-precompaction', '.state'));
assert(stateFiles.includes(`${SID}.json`) && stateFiles.includes(`${SID}.feedface0001.json`),
  'parent and lane keep separate state files');

// Parent state untouched by lane traffic: parent still sees its own transcript.
const parentState = JSON.parse(readFileSync(join(ws.cwd, '.codex-precompaction', '.state', `${SID}.json`), 'utf8'));
assert(parentState.transcript === ws.transcript, 'parent state still tracks the parent transcript');

// Lane marker note: SessionStart on the lane announces the lane id, not the parent id.
const ss = callHook(laneWs, 'SessionStart');
assert(ss.includes('marker is feedface0001'), 'lane SessionStart issues the lane-scoped marker');

console.log('lane-isolation: all assertions passed');
