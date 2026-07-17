#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(installerDir);
const sourceHook = join(repoRoot, 'hook', 'codex-precompaction-hook.mjs');
const configExample = join(repoRoot, 'config.toml.example');
const agentsExample = join(repoRoot, 'AGENTS.md.example');
const hookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact'];
const configStart = '# >>> codex-sane-compaction >>>';
const configEnd = '# <<< codex-sane-compaction <<<';
const agentsStart = '<!-- codex-sane-compaction:start -->';
const agentsEnd = '<!-- codex-sane-compaction:end -->';

function usage() {
  console.log(`Codex Sane Compaction installer

Usage:
  node installer/install.mjs [install] [options]
  node installer/install.mjs verify [options]

Options:
  --codex-home PATH         Target Codex home (default: CODEX_HOME or ~/.codex)
  --dry-run                 Report changes without writing
  --replace-existing-hook   Replace registrations for another codex-precompaction-hook.mjs
  --skip-token-budget       Do not manage config.toml token-budget configuration
  --skip-agents             Do not manage the AGENTS.md context-reset section
  --help                    Show this help

The installer never edits rollout/session data and never launches Codex. Existing
files that change are copied to a timestamped backup directory before atomic writes.`);
}

function parseArgs(argv) {
  const options = {
    command: 'install',
    codexHome: process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex'),
    dryRun: false,
    replaceExistingHook: false,
    tokenBudget: true,
    agents: true,
  };
  const args = [...argv];
  if (args[0] === 'install' || args[0] === 'verify') options.command = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--codex-home') {
      const value = args.shift();
      if (!value) throw new Error('--codex-home requires a path');
      options.codexHome = resolve(value);
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--replace-existing-hook') options.replaceExistingHook = true;
    else if (arg === '--skip-token-budget') options.tokenBudget = false;
    else if (arg === '--skip-agents') options.agents = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function requireSupportedNode() {
  const major = Number.parseInt(process.versions.node.split('.', 1)[0], 10);
  if (!Number.isInteger(major) || major < 18) {
    throw new Error(`Node.js 18 or newer is required (found ${process.versions.node})`);
  }
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function withTrailingNewline(text) {
  return `${text.replace(/\s+$/u, '')}\n`;
}

function appendBlock(text, start, body, end) {
  const prefix = text.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ''}${start}\n${body.trim()}\n${end}\n`;
}

function replaceManagedBlock(text, start, body, end) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt === -1 && endAt === -1) return null;
  if (startAt === -1 || endAt === -1 || endAt < startAt || text.indexOf(start, startAt + start.length) !== -1) {
    throw new Error(`malformed managed block: ${start}`);
  }
  const after = endAt + end.length;
  return withTrailingNewline(`${text.slice(0, startAt)}${start}\n${body.trim()}\n${end}${text.slice(after)}`);
}

function assertShellSafePath(path) {
  const unsafe = process.platform === 'win32' ? /["%!&|<>^\r\n]/u : /["$`\\\r\n]/u;
  if (unsafe.test(path)) {
    throw new Error(`installation path contains shell-expansion characters that cannot be registered safely: ${path}`);
  }
}

function commandFor(path) {
  assertShellSafePath(process.execPath);
  assertShellSafePath(path);
  return `"${process.execPath}" "${path}"`;
}

function isSameCommand(a, b) {
  if (typeof a !== 'string') return false;
  const norm = value => process.platform === 'win32'
    ? value.trim().replaceAll('/', '\\').toLowerCase()
    : value.trim();
  return norm(a) === norm(b);
}

function referencesCompactionHook(command) {
  return typeof command === 'string' && /codex-precompaction-hook\.mjs["']?\s*$/i.test(command.trim());
}

function hookCommands(config, event) {
  const commands = [];
  for (const group of config.hooks?.[event] ?? []) {
    for (const hook of group?.hooks ?? []) {
      if (typeof hook?.command === 'string') commands.push(hook.command);
    }
  }
  return commands;
}

function hookRegistrations(config, event) {
  const registrations = [];
  for (const group of config.hooks?.[event] ?? []) {
    for (const hook of group?.hooks ?? []) {
      if (referencesCompactionHook(hook?.command)) registrations.push({ group, hook });
    }
  }
  return registrations;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === '"' && escaped) { escaped = false; continue; }
    if (quote === '"' && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') return line.slice(0, i);
  }
  return line;
}

function splitTomlKey(value) {
  const parts = [];
  let quote = null;
  let current = '';
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '.') { parts.push(current.trim()); current = ''; }
    else current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function tokenBudgetDeclared(text) {
  let table = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const code = stripTomlComment(rawLine).trim();
    if (!code) continue;
    const tableMatch = code.match(/^\[{1,2}(.+?)\]{1,2}$/u);
    if (tableMatch) {
      table = splitTomlKey(tableMatch[1]);
      if (table[0] === 'features' && table[1] === 'token_budget') return true;
      continue;
    }
    const equals = code.indexOf('=');
    if (equals === -1) continue;
    const key = splitTomlKey(code.slice(0, equals));
    const fullKey = [...table, ...key];
    if (fullKey[0] === 'features' && fullKey[1] === 'token_budget') return true;
    if (!table.length && fullKey.length === 1 && fullKey[0] === 'features' &&
        /\btoken_budget\b/u.test(code.slice(equals + 1))) return true;
  }
  return false;
}

function mergeHooks(text, managedCommand, replaceExisting) {
  let config;
  try {
    config = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`hooks.json is not valid JSON: ${error.message}`);
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('hooks.json root must be an object');
  }
  config.description ??= 'Compaction survival hooks installed by codex-sane-compaction';
  config.hooks ??= {};
  if (Array.isArray(config.hooks) || typeof config.hooks !== 'object') {
    throw new Error('hooks.json "hooks" must be an object');
  }

  for (const event of hookEvents) {
    const groups = config.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`hooks.json hooks.${event} must be an array`);
    const oldCommands = hookCommands(config, event).filter(command =>
      referencesCompactionHook(command) && !isSameCommand(command, managedCommand));
    if (oldCommands.length && !replaceExisting) {
      throw new Error(
        `${event} already registers another codex-precompaction-hook.mjs. ` +
        'Re-run with --replace-existing-hook after reviewing the dry run.',
      );
    }

    const keptGroups = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter(hook =>
        !(referencesCompactionHook(hook?.command) &&
          (replaceExisting || isSameCommand(hook.command, managedCommand))));
      if (keptHooks.length) keptGroups.push({ ...group, hooks: keptHooks });
    }
    keptGroups.push({ hooks: [{
      type: 'command',
      command: managedCommand,
      timeout: event === 'PreCompact' ? 180 : 15,
    }] });
    config.hooks[event] = keptGroups;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function configText(current) {
  const body = readFileSync(configExample, 'utf8').trim();
  const replaced = replaceManagedBlock(current, configStart, body, configEnd);
  if (replaced !== null) return replaced;
  if (tokenBudgetDeclared(current)) {
    throw new Error(
      'config.toml already defines token_budget outside the installer-managed block. ' +
      'Review it and rerun with --skip-token-budget to preserve it unchanged.',
    );
  }
  return appendBlock(current, configStart, body, configEnd);
}

function agentsText(current) {
  const body = readFileSync(agentsExample, 'utf8')
    .replace(/^# Merge this section into your global ~\/\.codex\/AGENTS\.md\s*/u, '')
    .trim();
  const replaced = replaceManagedBlock(current, agentsStart, body, agentsEnd);
  if (replaced !== null) return replaced;
  if (/^##\s+Context resets\b/mu.test(current)) {
    throw new Error(
      'AGENTS.md already contains "## Context resets" outside the installer-managed block. ' +
      'Review it and rerun with --skip-agents to preserve it unchanged.',
    );
  }
  return appendBlock(current, agentsStart, body, agentsEnd);
}

function buildOperations(options) {
  const targetHook = join(options.codexHome, 'hooks', 'codex-sane-compaction', 'codex-precompaction-hook.mjs');
  const hooksPath = join(options.codexHome, 'hooks.json');
  const configPath = join(options.codexHome, 'config.toml');
  const agentsPath = join(options.codexHome, 'AGENTS.md');
  const operations = [];
  const add = (path, content) => {
    let stat = null;
    try { stat = lstatSync(path); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const existed = stat !== null;
    if (stat) {
      if (stat.isSymbolicLink() || stat.nlink > 1) {
        throw new Error(`refusing to replace linked file; preserve its topology manually: ${path}`);
      }
    }
    const old = existed ? readFileSync(path, 'utf8') : '';
    if (old !== content) operations.push({ path, existed, old, content });
  };

  add(targetHook, readFileSync(sourceHook, 'utf8'));
  add(hooksPath, mergeHooks(readOptional(hooksPath), commandFor(targetHook), options.replaceExistingHook));
  if (options.tokenBudget) add(configPath, configText(readOptional(configPath)));
  if (options.agents) add(agentsPath, agentsText(readOptional(agentsPath)));
  return { operations, targetHook, hooksPath, configPath, agentsPath };
}

function applyOperations(options, operations) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = join(options.codexHome, '.codex-sane-compaction-backups', timestamp);
  for (const operation of operations) {
    const action = operation.existed ? 'update' : 'create';
    console.log(`${options.dryRun ? 'would ' : ''}${action}: ${operation.path}`);
    if (options.dryRun) continue;
    mkdirSync(dirname(operation.path), { recursive: true });
    if (operation.existed) {
      const backupPath = join(backupRoot, relative(options.codexHome, operation.path));
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(operation.path, backupPath);
      console.log(`backup: ${backupPath}`);
    }
    const mode = existsSync(operation.path) ? statSync(operation.path).mode : undefined;
    const temp = `${operation.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, operation.content, mode === undefined ? undefined : { mode });
    renameSync(temp, operation.path);
  }
}

function verify(options, paths) {
  const failures = [];
  const installed = readOptional(paths.targetHook);
  if (!installed) failures.push(`installed hook missing: ${paths.targetHook}`);
  else if (installed !== readFileSync(sourceHook, 'utf8')) failures.push('installed hook differs from repository hook');

  let hooks = {};
  try { hooks = JSON.parse(readOptional(paths.hooksPath)); }
  catch (error) { failures.push(`hooks.json is invalid: ${error.message}`); }
  const expectedCommand = commandFor(paths.targetHook);
  for (const event of hookEvents) {
    const registrations = hookRegistrations(hooks, event);
    const expectedTimeout = event === 'PreCompact' ? 180 : 15;
    const registration = registrations[0];
    if (registrations.length !== 1 ||
        !isSameCommand(registration?.hook?.command, expectedCommand) ||
        registration?.hook?.type !== 'command' ||
        registration?.hook?.timeout !== expectedTimeout ||
        registration?.group?.matcher !== undefined ||
        registration?.group?.hooks?.length !== 1) {
      failures.push(`${event} does not have exactly one complete managed hook registration`);
    }
  }
  if (options.tokenBudget) {
    const expectedConfig = `${configStart}\n${readFileSync(configExample, 'utf8').trim()}\n${configEnd}`;
    if (!readOptional(paths.configPath).includes(expectedConfig)) {
      failures.push('config.toml lacks the complete installer-managed token-budget block');
    }
  }
  if (options.agents) {
    const expectedAgentsBody = readFileSync(agentsExample, 'utf8')
      .replace(/^# Merge this section into your global ~\/\.codex\/AGENTS\.md\s*/u, '')
      .trim();
    const expectedAgents = `${agentsStart}\n${expectedAgentsBody}\n${agentsEnd}`;
    if (!readOptional(paths.agentsPath).includes(expectedAgents)) {
      failures.push('AGENTS.md lacks the complete installer-managed context-reset block');
    }
  }
  if (failures.length) throw new Error(`verification failed:\n- ${failures.join('\n- ')}`);
  console.log(`verified installation at ${options.codexHome}`);
}

try {
  requireSupportedNode();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  if (options.command === 'verify') {
    const paths = buildOperations({ ...options, replaceExistingHook: true });
    verify(options, paths);
    process.exit(0);
  }
  const result = buildOperations(options);
  applyOperations(options, result.operations);
  if (!result.operations.length) console.log('already installed; no changes needed');
  if (!options.dryRun) verify(options, result);
  else console.log('dry run complete; no files were written');
  console.log('Restart Codex and approve the hook in /hooks before relying on it.');
} catch (error) {
  console.error(`codex-sane-compaction installer: ${error.message}`);
  process.exit(1);
}
