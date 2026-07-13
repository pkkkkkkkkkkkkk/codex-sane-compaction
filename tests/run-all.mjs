// Runs every *.test.mjs in this directory. Exit 0 = all pass.
import { readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()) {
  process.stdout.write(`\n=== ${f}\n`);
  try {
    process.stdout.write(execFileSync('node', [join(here, f)], { encoding: 'utf8' }));
  } catch (e) {
    process.stdout.write((e.stdout ?? '') + (e.stderr ?? ''));
    failed++;
  }
}
rmSync(join(here, '.tmp'), { recursive: true, force: true });
console.log(failed ? `\n${failed} test file(s) FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
