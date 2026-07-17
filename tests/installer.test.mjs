// The installer is exercised only against an explicit isolated Codex home.
// It must preserve unrelated configuration, be idempotent, back up changes,
// reject ambiguous hook migrations, and keep dry runs side-effect free.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, mkdirSync, assert } from './helpers.mjs';

const installerPath = fileURLToPath(new URL('../installer/install.mjs', import.meta.url));
const sourceHook = fileURLToPath(new URL('../hook/codex-precompaction-hook.mjs', import.meta.url));
const helpersUrl = new URL('./helpers.mjs', import.meta.url).href;
const ws = makeWorkspace(`installer-${process.pid}-${Date.now()}`);
const home = join(ws.cwd, 'codex-home');
mkdirSync(home, { recursive: true });
const preexistingHook = join(home, 'hooks', 'codex-sane-compaction', 'codex-precompaction-hook.mjs');
mkdirSync(join(home, 'hooks', 'codex-sane-compaction'), { recursive: true });
writeFileSync(preexistingHook, '');

writeFileSync(join(home, 'hooks.json'), JSON.stringify({
  description: 'existing hooks',
  hooks: {
    PreToolUse: [{ matcher: '^shell$', hooks: [{ type: 'command', command: 'node unrelated.mjs', timeout: 3 }] }],
  },
}, null, 2) + '\n');
writeFileSync(join(home, 'config.toml'), 'model = "example"\n');
writeFileSync(join(home, 'AGENTS.md'), '# Existing guidance\n\nKeep this line.\n');

const run = (...args) => execFileSync('node', [installerPath, ...args, '--codex-home', home], { encoding: 'utf8', stdio: 'pipe' });
const first = run('install');
assert(first.includes('verified installation'), 'installer verifies its isolated target');

const installedHook = join(home, 'hooks', 'codex-sane-compaction', 'codex-precompaction-hook.mjs');
assert(readFileSync(installedHook, 'utf8') === readFileSync(sourceHook, 'utf8'), 'installed hook matches repository hook');

const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
assert(hooks.description === 'existing hooks', 'existing hooks.json metadata is preserved');
assert(hooks.hooks.PreToolUse.some(group => group.matcher === '^shell$'), 'unrelated existing hook is preserved');
for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact']) {
  const matches = (hooks.hooks[event] ?? []).flatMap(group => group.hooks ?? [])
    .filter(hook => hook.command?.includes('codex-precompaction-hook.mjs'));
  assert(matches.length === 1, `${event} receives exactly one compaction hook`);
  assert(matches[0].command.includes(process.execPath), `${event} pins the absolute Node executable`);
}
assert(readFileSync(join(home, 'config.toml'), 'utf8').includes('model = "example"'), 'existing config.toml content is preserved');
assert(readFileSync(join(home, 'config.toml'), 'utf8').includes('[features.token_budget]'), 'token-budget block is installed');
assert(readFileSync(join(home, 'AGENTS.md'), 'utf8').includes('Keep this line.'), 'existing AGENTS.md content is preserved');
assert(readFileSync(join(home, 'AGENTS.md'), 'utf8').includes('## Context resets'), 'context-reset guidance is installed');

const backupBase = join(home, '.codex-sane-compaction-backups');
assert(existsSync(backupBase) && readdirSync(backupBase).length === 1, 'changed user files receive one timestamped backup set');
const backupSet = join(backupBase, readdirSync(backupBase)[0]);
assert(existsSync(join(backupSet, 'hooks', 'codex-sane-compaction', 'codex-precompaction-hook.mjs')),
  'zero-byte pre-existing hook receives a backup');
const beforeSecond = [
  readFileSync(installedHook, 'utf8'),
  readFileSync(join(home, 'hooks.json'), 'utf8'),
  readFileSync(join(home, 'config.toml'), 'utf8'),
  readFileSync(join(home, 'AGENTS.md'), 'utf8'),
];
const second = run('install');
assert(second.includes('already installed; no changes needed'), 'second install is idempotent');
assert(readdirSync(backupBase).length === 1, 'idempotent install creates no extra backup');
assert(JSON.stringify(beforeSecond) === JSON.stringify([
  readFileSync(installedHook, 'utf8'),
  readFileSync(join(home, 'hooks.json'), 'utf8'),
  readFileSync(join(home, 'config.toml'), 'utf8'),
  readFileSync(join(home, 'AGENTS.md'), 'utf8'),
]), 'idempotent install leaves files byte-identical');
assert(run('verify').includes('verified installation'), 'standalone verify succeeds');

const malformedHooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
const preCompactHook = malformedHooks.hooks.PreCompact.flatMap(group => group.hooks ?? [])
  .find(hook => hook.command?.includes('codex-precompaction-hook.mjs'));
preCompactHook.timeout = 1;
writeFileSync(join(home, 'hooks.json'), JSON.stringify(malformedHooks, null, 2) + '\n');
let malformedVerify = '';
try { run('verify'); }
catch (error) { malformedVerify = `${error.stdout ?? ''}${error.stderr ?? ''}`; }
assert(malformedVerify.includes('complete managed hook registration'), 'verify rejects an incomplete hook registration');
writeFileSync(join(home, 'hooks.json'), beforeSecond[1]);

const conflictHome = join(ws.cwd, 'conflict-home');
mkdirSync(conflictHome, { recursive: true });
writeFileSync(join(conflictHome, 'hooks.json'), JSON.stringify({ hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: 'node "/other/codex-precompaction-hook.mjs"' }] }],
} }, null, 2));
let conflict = '';
try {
  execFileSync('node', [installerPath, '--codex-home', conflictHome], { encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  conflict = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
assert(conflict.includes('--replace-existing-hook'), 'ambiguous existing hook requires explicit replacement flag');
assert(!existsSync(join(conflictHome, 'hooks', 'codex-sane-compaction')), 'conflict fails before writing');

for (const [name, existing] of [
  ['commented-table', '[features.token_budget] # retained local config\nenabled = true\n'],
  ['scalar-feature', '[features]\ntoken_budget = true\n'],
  ['dotted-feature', 'features.token_budget.enabled = true\n'],
  ['relative-dotted-feature', '[features]\ntoken_budget.enabled = true\n'],
  ['disabled-table', '[features.token_budget]\nenabled = false\n'],
]) {
  const tomlHome = join(ws.cwd, `toml-${name}`);
  mkdirSync(tomlHome, { recursive: true });
  writeFileSync(join(tomlHome, 'config.toml'), existing);
  let output = '';
  try {
    execFileSync('node', [installerPath, '--codex-home', tomlHome], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert(output.includes('--skip-token-budget'), `${name} token-budget config is treated as a conflict`);
  assert(readFileSync(join(tomlHome, 'config.toml'), 'utf8') === existing, `${name} config remains byte-identical`);
  assert(!existsSync(join(tomlHome, 'hooks')), `${name} conflict fails before writing any hook`);
}

const agentsHome = join(ws.cwd, 'agents-conflict');
mkdirSync(agentsHome, { recursive: true });
writeFileSync(join(agentsHome, 'AGENTS.md'), '## Context resets\n\nExisting local policy.\n');
let agentsConflict = '';
try {
  execFileSync('node', [installerPath, '--codex-home', agentsHome], { encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  agentsConflict = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
assert(agentsConflict.includes('--skip-agents'), 'unmanaged Context resets section requires explicit skip');
assert(!existsSync(join(agentsHome, 'hooks')), 'AGENTS conflict fails before writing any hook');

const harmlessTomlHome = join(ws.cwd, 'harmless-toml');
mkdirSync(harmlessTomlHome, { recursive: true });
const harmlessToml = 'model_instructions_file = "/docs/token_budget.md"\nmodel = "x" # token_budget note\n';
writeFileSync(join(harmlessTomlHome, 'config.toml'), harmlessToml);
const harmlessOutput = execFileSync('node', [installerPath, '--skip-agents', '--codex-home', harmlessTomlHome], { encoding: 'utf8' });
assert(harmlessOutput.includes('verified installation'), 'harmless token_budget text in TOML values/comments does not conflict');
assert(readFileSync(join(harmlessTomlHome, 'config.toml'), 'utf8').startsWith(harmlessToml), 'harmless TOML content is preserved');

const linkedHome = join(ws.cwd, 'linked-config');
mkdirSync(linkedHome, { recursive: true });
const linkedTarget = join(ws.cwd, 'linked-config-target.toml');
writeFileSync(linkedTarget, 'model = "linked"\n');
let symlinkSupported = true;
try { symlinkSync(linkedTarget, join(linkedHome, 'config.toml'), 'file'); }
catch { symlinkSupported = false; }
if (symlinkSupported) {
  let linkedOutput = '';
  try {
    execFileSync('node', [installerPath, '--skip-agents', '--codex-home', linkedHome], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    linkedOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert(linkedOutput.includes('refusing to replace linked file'), 'linked config is rejected before writing');
  assert(!existsSync(join(linkedHome, 'hooks')), 'linked config rejection writes no hook');

  const danglingHome = join(ws.cwd, 'dangling-config');
  mkdirSync(danglingHome, { recursive: true });
  symlinkSync(join(ws.cwd, 'missing-config-target.toml'), join(danglingHome, 'config.toml'), 'file');
  let danglingOutput = '';
  try {
    execFileSync('node', [installerPath, '--skip-agents', '--codex-home', danglingHome], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    danglingOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert(danglingOutput.includes('refusing to replace linked file'), 'dangling config symlink is rejected before writing');
  assert(!existsSync(join(danglingHome, 'hooks')), 'dangling symlink rejection writes no hook');
} else {
  console.log('  skip: file symlinks unavailable; Linux CI covers linked-config rejection');
}

let unsafeRunId = '';
try {
  execFileSync('node', ['--input-type=module', '--eval', `await import(${JSON.stringify(helpersUrl)})`], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, CODEX_TEST_RUN_ID: '../../escape' },
  });
} catch (error) {
  unsafeRunId = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
assert(unsafeRunId.includes('one safe path segment'), 'unsafe test run id is rejected before path construction');

const unsafeSegment = process.platform === 'win32' ? '%TEMP%' : '$HOME';
const unsafeHome = join(ws.cwd, unsafeSegment, 'codex-home');
let unsafeOutput = '';
try {
  execFileSync('node', [installerPath, '--dry-run', '--codex-home', unsafeHome], { encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  unsafeOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
assert(unsafeOutput.includes('shell-expansion characters'), 'unsafe shell-expanding install path is rejected');
assert(!existsSync(unsafeHome), 'unsafe path is rejected without writes');

const dryHome = join(ws.cwd, 'dry-run-home');
const dry = execFileSync('node', [installerPath, '--dry-run', '--codex-home', dryHome], { encoding: 'utf8' });
assert(dry.includes('dry run complete'), 'dry run reports completion');
assert(!existsSync(dryHome), 'dry run creates no Codex home');

console.log('installer: PASS');
