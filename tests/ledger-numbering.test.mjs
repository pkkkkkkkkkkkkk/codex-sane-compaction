// Ledger cycle numbers derive from files on disk (state resets when a resume
// swaps the rollout file) and pair with the model's checkpoint for the cycle.
import { makeWorkspace, callHook, assert, writeFileSync, mkdirSync, join, SID8 } from './helpers.mjs';
import { readdirSync } from 'node:fs';

const ws = makeWorkspace('ledgernum');
const dir = join(ws.cwd, '.codex-precompaction');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `PRECOMPACTION_${SID8}_1.md`), 'x');
writeFileSync(join(dir, `PRECOMPACTION_${SID8}_1_ledger.md`), 'old');
writeFileSync(join(dir, `PRECOMPACTION_${SID8}_2.md`), 'x');
writeFileSync(ws.transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { model: 'test' } }) + '\n');

callHook(ws, 'PreCompact');
const files = readdirSync(dir).sort();
assert(files.includes(`PRECOMPACTION_${SID8}_2_ledger.md`), 'ledger pairs with checkpoint _2');
assert(readdirSync(dir).filter(f => f.endsWith('_1_ledger.md')).length === 1
  && String(files.length) === '4', 'old ledger not overwritten, no extras');

console.log('ledger-numbering: PASS');
