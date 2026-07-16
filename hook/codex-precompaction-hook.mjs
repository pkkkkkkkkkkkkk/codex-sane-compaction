// Codex compaction-survival hook (PostToolUse + PreToolUse + PreCompact).
//
// Problem: Codex compaction (remote v2) replaces old history with a tenseless
// server-written summary; the model then misreads long-resolved events as
// current. This hook gives each compaction cycle a fresh checkpoint artifact:
//
//  - PostToolUse (every tool call, incremental-tail read, ~ms):
//      context fill >= 80% of window -> inject a one-shot instruction to write
//      PRECOMPACTION_<sid>_<n>.md from full (uncompacted) context, then keep working.
//  - PreCompact (rare): deterministically generate a factual timeline ledger
//    PRECOMPACTION_<sid>_<n>_ledger.md from the full rollout as a backstop
//    (covers the case where compaction outran the model's own checkpoint).
//  - PreToolUse: after a compaction, DENY the first tool call (once) with a
//    reason pointing at the newest checkpoint — so the model reads it before
//    doing anything at all. A call that itself reads the checkpoint is allowed.
//
// Artifacts live in <workspace>/.codex-precompaction/ ; one file per cycle,
// nothing stacks in context, and subagents get their own artifacts for free
// (hooks run per-session with that session's transcript_path/session_id).
// State per session in .codex-precompaction/.state/<session_id>.json.

import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, readdirSync, createReadStream, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Auto-compaction triggers at 90% of the window (openai_models.rs: context_window*9/10);
// the native token_budget reminder fires 45k before that (~73% of the live 258.4k window).
// 0.85 sits between them: native always speaks first, and we still have ~13k before the reset.
const NAG_FILL_RATIO = 0.85;

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return null; }
}

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

const input = readStdin();
if (!input || !input.transcript_path || !input.cwd) process.exit(0);

const sid = String(input.session_id ?? 'unknown');

// Subagent lanes report the PARENT thread id as session_id, so keying the
// marker and state on it collides with the parent (observed in production:
// a lane's compaction stole the parent's next ledger slot, and the shared
// state file thrashed between the two transcripts). Detect lanes from the
// rollout's session_meta and key them by their own rollout file id instead.
function laneId() {
  try {
    const fd = openSync(input.transcript_path, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const meta = JSON.parse(buf.toString('utf8', 0, n).split('\n', 1)[0]);
    if (!(meta?.payload?.source?.subagent ?? meta?.source?.subagent)) return null;
    const m = input.transcript_path.match(/([0-9a-fA-F]{12})\.jsonl$/);
    if (m) return m[1].toLowerCase();
    let h = 0;
    for (const c of input.transcript_path) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return 'lane' + h.toString(16).padStart(8, '0');
  } catch { return null; }
}
const lane = laneId();
const sid8 = lane ?? sid.replace(/-/g, '').slice(-12);
const artDir = join(input.cwd, '.codex-precompaction');
const stateDir = join(artDir, '.state');
const statePath = join(stateDir, `${lane ? `${sid}.${lane}` : sid}.json`);
const artName = n => `PRECOMPACTION_${sid8}_${n}.md`;
const ledgerName = n => `PRECOMPACTION_${sid8}_${n}_ledger.md`;

function loadState() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}
function saveState(s) {
  // atomic: a torn write would parse as "no state" and silently reset cycle counters
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, statePath);
}

const isCompaction = j =>
  j.type === 'compacted' ||
  j.payload?.type === 'compacted' ||
  j.payload?.type === 'context_compacted' ||
  // token_budget-feature reset (summary-free new window) emits a ContextCompaction turn item
  j.type === 'ContextCompaction' ||
  j.payload?.type === 'ContextCompaction';

// Newest existing checkpoint (model-written preferred over ledger) for this session.
function newestArtifact() {
  let files;
  try { files = readdirSync(artDir); } catch { return null; }
  let best = null, bestN = -1, bestLedger = true;
  for (const f of files) {
    const m = f.match(new RegExp(`^PRECOMPACTION_${sid8}_(\\d+)(_ledger)?\\.md$`));
    if (!m) continue;
    const n = parseInt(m[1], 10), isLedger = !!m[2];
    if (n > bestN || (n === bestN && bestLedger && !isLedger)) { best = f; bestN = n; bestLedger = isLedger; }
  }
  return best;
}

// Incremental tail scan of the rollout; returns up-to-date state or null (fresh init).
function scanTail() {
  let size;
  try { size = statSync(input.transcript_path).size; } catch { return null; }
  let s = loadState();
  if (!s || s.transcript !== input.transcript_path || size < s.offset) {
    // first sight (or rollout swapped): start tailing from EOF, count nothing historical
    s = { transcript: input.transcript_path, offset: size, compactions: 0, naggedCycle: 0, remindedCycle: 0, fill: 0, window: 0 };
    saveState(s);
    return null;
  }
  if (size > s.offset) {
    const fd = openSync(input.transcript_path, 'r');
    const buf = Buffer.alloc(size - s.offset);
    readSync(fd, buf, 0, buf.length, s.offset);
    closeSync(fd);
    // Only consume up to the last complete line: a partially-written trailing
    // record must be re-read next invocation, not skipped past and lost.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) { saveState(s); return s; }
    s.offset += lastNl + 1;
    for (const line of buf.toString('utf8', 0, lastNl + 1).split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (isCompaction(j)) {
        // one real reset can emit multiple compaction-shaped records within the
        // same instant (observed in production rollouts) — count it once
        const ts = Date.parse(j.timestamp) || Date.now();
        if (ts - (s.lastCompactionTs ?? 0) > 5000) {
          s.compactions++;
          s.gateDenials = 0;
          s.fill = 0; // fill is stale until the next token_count
        }
        s.lastCompactionTs = ts;
      }
      // native token_budget reminder already told the model to checkpoint -> our nag stands down this cycle
      if (line.includes('TOKEN-BUDGET-REMINDER') || line.includes('tokens remain before a summary-free context reset')) {
        s.nativeNagCycle = s.compactions + 1;
      }
      if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
        const u = j.payload.info?.last_token_usage;
        const w = j.payload.info?.model_context_window;
        if (u) s.fill = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        if (w) s.window = w;
      }
    }
  }
  return s;
}

// Canonical checkpoint format, self-provisioned into each workspace as
// .codex-precompaction/FORMAT.md so every path (native reminder, hook nag,
// manual "compact first", AGENTS.md resume rule) references one source of truth.
const FORMAT_MD = `# Checkpoint format (PRECOMPACTION files)

A checkpoint is the ONLY memory that survives a context reset. Write it from your
full current context, for a reader who knows nothing except this file. Sections:

1. TASK — the active assignment, disambiguated for a reader without your context:
   - Quote: the user's own words for the current assignment, verbatim (1-3
     lines, dated). Paraphrase is where meaning drift enters; the quote is the
     ground truth your post-reset self audits its interpretation against.
   - Meaning: what the assignment requires, in your words.
   - Not: the nearest plausible WRONG reading, ruled out explicitly (often the
     previously rejected approach). If you cannot name one, you have not
     actually checked for ambiguity — your full-context self cannot see which
     of its phrasings are ambiguous to a reader without that context.
   - Why: the reason behind the requirement. A naked instruction gets quietly
     traded away under implementation pressure (e.g. reshaped to fit what the
     current tooling can do); an instruction with its reason attached does not.
2. INVARIANTS — standing project truths that hold across EVERY cycle: design
   principles, hard constraints, "never do X" rules. COPY this section forward
   verbatim from the previous checkpoint, then append new entries; never
   re-summarize it from memory and never drop an entry without an explicit
   user decision recorded in DECISIONS. Re-written from memory each cycle,
   these decay silently — copying is what makes them survive long sessions.
3. PLAN — the plan you are following, near-verbatim, including anything the user
   just approved or amended.
4. STATUS — done / not done / currently doing. Every "done" item must note how it
   was VERIFIED (test run, diff inspected, in-engine check), not merely written.
5. USER NOTES — corrections, preferences, promises and session-specific
   constraints the user stated (e.g. "don't touch X until Y"). These outrank
   your own preferences after the reset.
6. DECISIONS — key choices with reasons, INCLUDING rejections: "A rejected
   because B — do not retry A". Negative knowledge prevents re-litigating.
7. INCIDENTS — past problems with date-time and resolution status, e.g.
   "app restart 2026-07-12 18:56 — resolved, all lanes respawned". Anything
   listed here is HISTORY; your post-reset self must not treat it as new.
8. POINTERS — commit hashes, branch, key file paths, artifact locations. One
   line each. Never inline file contents; the filesystem survives the reset.
9. IN-FLIGHT — running subagents and their assignments, background processes,
   locks, temporary workarounds. State "none" explicitly if none.
10. NEXT — the exact next action, concretely, including what NOT to redo
   (expensive reruns, re-verification that already passed).
11. WORKING SET — knowledge you already dug up and will need again right after
   the reset: exact file paths with line numbers, symbol/function names, how the
   relevant subsystems behave, commands that worked. Anything you would
   otherwise have to re-search.
12. NOW — the live interaction state at the moment of writing, which the reset
   does NOT change:
   - the exact action you were performing or about to perform;
   - your own pending intent: if you were about to stop, yield, respond, ask
     the user something, or wait for their approval, that is STILL your next
     move after the reset — resuming does not convert a pending question or
     planned stop into permission to keep working;
   - any live user signals: a stop/escape/interruption the user just issued,
     an answer you are waiting for, a correction acknowledged but not yet
     applied. User-issued stops and corrections REMAIN IN FORCE across the
     reset — a fresh context or new turn does NOT clear them; only the user can.

Rules: no narrative recap and no conversation back-and-forth — record outcomes
and current state only. Date-stamp past events. Keep it under ~150 lines.
Name the file PRECOMPACTION_<your session marker>_<n>.md in this directory.

Ambiguity check (applies to EVERY section, not just TASK): you cannot see your
own ambiguity — the context that resolves it is in your head, not in the file,
and your post-reset self will have only the file. Assume any load-bearing
phrase that admits two readings WILL be read the wrong way. Prefer concrete
referents (paths, asset names, counts) over abstractions, and where a phrase
could be taken two ways, say which way is wrong — "one connected hull
(assembled from separate prefab assets, NOT a single merged mesh)".

After a reset: if reality (tooling limits, code structure, gate failures)
pushes against TASK Meaning, re-read TASK Quote and Why before adapting —
extending the tooling may BE the task. A requirement does not shrink because
the current code cannot express it yet.
`;

function provisionFormat() {
  try {
    const p = join(artDir, 'FORMAT.md');
    let cur = null;
    try { cur = readFileSync(p, 'utf8'); } catch { /* missing */ }
    if (cur !== FORMAT_MD) { mkdirSync(artDir, { recursive: true }); writeFileSync(p, FORMAT_MD); }
  } catch { /* non-fatal */ }
}

// ---------------- SessionStart: disown other sessions' checkpoints ----------------
function sessionStart() {
  provisionFormat();
  let leftovers = [];
  try {
    leftovers = readdirSync(artDir).filter(f => /^PRECOMPACTION_.+\.md$/.test(f));
  } catch { /* no dir yet */ }
  const foreign = leftovers.filter(f => !f.includes(`_${sid8}_`));
  const marker =
    `[precompaction-hook] Your session marker is ${sid8} (session started ${new Date().toISOString()}). ` +
    `Use it in any checkpoint filename you are asked to write (PRECOMPACTION_${sid8}_<n>.md).`;
  const disown = foreign.length === 0 ? '' :
    ` .codex-precompaction/ currently holds ${foreign.length} checkpoint/ledger file(s) from previous or ` +
    `parallel sessions — they are NOT yours; ignore them entirely and do not resume anything from them. ` +
    `Only checkpoint files containing _${sid8}_ in the filename, created later during this session, are yours; ` +
    `the AGENTS.md mid-task resume rule applies to those only.`;
  out({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: marker + disown,
    },
  });
}

// ---------------- PreToolUse: post-compaction read-the-checkpoint gate ----------------
// Denies unrelated actions until a checkpoint-targeting call COMPLETES (recorded by
// PostToolUse), capped at 2 denials — a model reading via a variable/glob would
// otherwise be denied forever while genuinely complying.
const touchesCheckpoint = () => {
  const t = JSON.stringify(input.tool_input ?? '');
  return t.includes('PRECOMPACTION_') || t.includes('.codex-precompaction');
};

function preToolUse() {
  const s = scanTail();
  if (!s) return;
  if (s.compactions <= s.remindedCycle) { saveState(s); return; }
  const art = newestArtifact();
  if (!art) {
    // nothing to read; warn once, don't block
    s.remindedCycle = s.compactions;
    saveState(s);
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `[precompaction-hook] Context was just compacted and no checkpoint file exists for this session. ` +
          `Your history is a lossy, tenseless summary — it may present long-resolved events (crashes, ` +
          `interruptions, past decisions) as new or ongoing. Re-derive progress from git status/diff and the ` +
          `filesystem before acting on anything the summary claims.`,
      },
    });
    return;
  }
  if (touchesCheckpoint()) { saveState(s); return; } // reading it now; PostToolUse records the proof
  if ((s.gateDenials ?? 0) >= 2) {
    // cap reached: stop fighting, latch, and warn instead
    s.remindedCycle = s.compactions;
    saveState(s);
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `[precompaction-hook] Proceeding without a verified checkpoint read after ${s.gateDenials} denials. ` +
          `Your history is a lossy post-compaction summary; read ${join(artDir, art)} before trusting it, ` +
          `and reconcile with git status/diff.`,
      },
    });
    return;
  }
  s.gateDenials = (s.gateDenials ?? 0) + 1;
  saveState(s);
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[precompaction-hook] Context was just compacted; your history is now a lossy, tenseless summary that may ` +
        `present long-resolved events as new or ongoing. Before this or any other action, read ` +
        `${join(artDir, art)} — it was written BEFORE compaction from full context and overrides your ` +
        `recollection of progress and timeline. Then retry your action informed by it.`,
    },
  });
}

// ---------------- PostToolUse: approaching-compaction checkpoint nag ----------------
function postToolUse() {
  const s = scanTail();
  if (!s) return;
  // completed checkpoint-targeting call = proof of read; releases the PreToolUse gate
  if (s.compactions > s.remindedCycle && touchesCheckpoint()) {
    s.remindedCycle = s.compactions;
    s.gateDenials = 0;
  }
  const cycle = s.compactions + 1;
  if (s.nativeNagCycle === cycle) { saveState(s); return; } // native reminder owns this cycle
  if (s.window > 0 && s.fill / s.window >= NAG_FILL_RATIO && s.naggedCycle < cycle) {
    s.naggedCycle = cycle;
    saveState(s);
    const file = join(artDir, artName(cycle));
    out({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[precompaction-hook] Context is at ${Math.round((100 * s.fill) / s.window)}% of the window; a context ` +
          `reset is imminent and nothing of your own work-history will survive it. Before doing anything else, ` +
          `read ${join(artDir, 'FORMAT.md')} and write a checkpoint to ${file} following it exactly ` +
          `(TASK with the user's assignment quoted verbatim + meaning + ruled-out wrong reading + why, ` +
          `INVARIANTS copied forward verbatim from the previous checkpoint, PLAN, STATUS+verification, ` +
          `USER NOTES, DECISIONS+rejections, INCIDENTS dated, POINTERS, IN-FLIGHT, NEXT, WORKING SET, ` +
          `NOW incl. live user signals — outcomes only, no narrative). ` +
          `Then continue the task where you left off.`,
      },
    });
    return;
  }
  saveState(s);
}

// ---------------- PreCompact: deterministic ledger from full rollout ----------------
async function preCompact() {
  // Derive the cycle from files on disk, not transcript-scoped state: a resume
  // swaps the rollout file and resets the state counter, which would shadow-
  // number and overwrite earlier ledgers. Pair with the model's checkpoint if
  // it already wrote one this cycle; otherwise take the next free slot.
  let ckptHigh = 0;
  const ledgers = new Set();
  try {
    for (const f of readdirSync(artDir)) {
      const m = f.match(new RegExp(`^PRECOMPACTION_${sid8}_(\\d+)(_ledger)?\\.md$`));
      if (!m) continue;
      if (m[2]) ledgers.add(parseInt(m[1], 10));
      else ckptHigh = Math.max(ckptHigh, parseInt(m[1], 10));
    }
  } catch { /* no dir yet */ }
  let cycle = Math.max(ckptHigh, (loadState()?.compactions ?? 0) + 1, 1);
  while (ledgers.has(cycle)) cycle++;
  const lines = [];
  let model = '?', firstTs = '', lastTs = '', patches = 0;
  const rl = createInterface({ input: createReadStream(input.transcript_path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const ts = (j.timestamp ?? '').slice(0, 16).replace('T', ' ');
    if (!firstTs && ts) firstTs = ts;
    if (ts) lastTs = ts;
    const p = j.payload ?? {};
    if (j.type === 'turn_context' && p.model) model = p.model;
    if (j.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const txt = (p.content ?? []).map(c => c.text ?? '').join(' ').replace(/\s+/g, ' ');
      if (txt.startsWith('<environment_context') || txt.startsWith('# AGENTS')) continue;
      lines.push(`[${ts}] USER: ${txt.slice(0, 300)}`);
    }
    if (j.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const txt = (p.content ?? []).map(c => c.text ?? '').join(' ').replace(/\s+/g, ' ');
      lines.push(`[${ts}] ASSISTANT: ${txt.slice(0, 200)}`);
    }
    if (j.type === 'event_msg' && p.type === 'patch_apply_end') {
      patches++;
      const files = Object.keys(p.changes ?? {}).map(f => f.split(/[\\/]/).pop()).slice(0, 6).join(', ');
      lines.push(`[${ts}] PATCH APPLIED${files ? ': ' + files : ''}`);
    }
    if (j.type === 'event_msg' && (p.type === 'turn_aborted' || p.type === 'error' || p.type === 'stream_error')) {
      lines.push(`[${ts}] !! ${p.type}${p.reason ? ' (' + p.reason + ')' : ''} — RESOLVED HISTORICAL EVENT unless it is the last line of this ledger`);
    }
    if (isCompaction(j)) lines.push(`[${ts}] -- context compacted --`);
  }
  const MAX = 400;
  const shown = lines.length > MAX ? lines.slice(lines.length - MAX) : lines;
  const doc = [
    `# Pre-compaction ledger — session ${sid8}, cycle ${cycle}`,
    ``,
    `Generated automatically from the FULL rollout transcript at ${lastTs} (session began ${firstTs}, model ${model}, ${patches} patches applied total).`,
    `Every line is a dated fact. Events listed here are HISTORY — do not treat any of them as new.`,
    lines.length > MAX ? `(${lines.length - MAX} older lines omitted; newest ${MAX} kept)` : ``,
    ``,
    ...shown,
  ].join('\n');
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, ledgerName(cycle)), doc);
}

const ev = input.hook_event_name;
if (ev === 'PostToolUse') postToolUse();
else if (ev === 'PreToolUse') preToolUse();
else if (ev === 'SessionStart') sessionStart();
else if (ev === 'PreCompact') await preCompact();
