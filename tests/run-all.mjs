// Runs every *.test.mjs in this directory. Exit 0 = all pass.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmpBase = process.env.CODEX_TEST_TMP_ROOT
  ? resolve(process.env.CODEX_TEST_TMP_ROOT)
  : join(here, '.tmp');
const runId = `run-${process.pid}-${Date.now()}`;
const tmpRoot = join(tmpBase, `codex-sane-compaction-${runId}`);
const testEnv = { ...process.env, CODEX_TEST_RUN_ID: runId };
let failed = 0;
for (const f of readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()) {
  process.stdout.write(`\n=== ${f}\n`);
  try {
    process.stdout.write(execFileSync('node', [join(here, f)], { encoding: 'utf8', env: testEnv }));
  } catch (e) {
    process.stdout.write((e.stdout ?? '') + (e.stderr ?? ''));
    failed++;
  }
}
console.log(`\nretained test artifacts: ${tmpRoot}`);
console.log(failed ? `\n${failed} test file(s) FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
