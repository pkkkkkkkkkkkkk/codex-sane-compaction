> ## ⚠️ Never press `/compact` — type **"compact first"** to the model instead — [why?](#never-press-compact)

# Codex Sane Compaction

**Model-authored checkpoints and summary-free context resets** — or: Codex
compaction, but actually not braindead.

Replaces Codex's lossy auto-compaction summaries with model-written,
task-directed handoff files + clean context resets, using only official
surfaces: an under-development feature flag, the hooks system, and AGENTS.md.

> **Status: experimental.** Built and tested against Codex `0.144.0-alpha.4`
> (July 2026), riding the under-development `token_budget` feature flag.
> Maintained best-effort: it gets fixed when it breaks for me. Pin your
> expectations accordingly.

<a id="never-press-compact"></a>
## Never press `/compact`

The one habit change this setup demands: with the flag on, the `/compact` UI
command resets **immediately** — *before* the model can write its checkpoint.
You'd resume from the machine-generated ledger (dated facts, no intent) instead
of the model's own handoff. Instead, just **tell the model**: `"compact first"`
or `"checkpoint, then compact"`. The AGENTS.md rules turn that into
checkpoint → self-reset → resume, with everything preserved.

Bonus: plain text works from any surface, including remote bridges and mobile
clients that have no slash commands at all.

## The problem

When Codex compacts a long session, the server-side summarizer keeps **only
user / developer / system messages** verbatim. Every assistant message, every
reasoning block, every tool call and result — i.e. *all of the model's own
work-history* — is deleted and survives only as a short, tenseless summary
(`codex-rs/core/src/compact_remote_v2.rs`, `is_retained_for_remote_compaction_v2`).

Symptoms you may recognize:

- post-compaction, the model treats **long-resolved incidents as breaking news**
  (a crash from yesterday becomes "the app just crashed!");
- it forgets what was finished vs. pending and re-does or skips work;
- it knows what *you* said but is fuzzy about what *it* did — exactly the
  asymmetry the retention filter predicts.

Empirically, an engaged model writes a far better handoff for its future self
than any summarization pass over the transcript — it is *inside* the task and
knows what tomorrow-self needs. This repo just makes that the mechanism.

## How it works

```
work ────────────────► ~73% full: native reminder fires (exact token count)
                        │  model writes .codex-precompaction/PRECOMPACTION_<sid>_<n>.md
                        │  (12-section checkpoint, see docs/FORMAT.md)
                        ▼
                       model calls the `new_context` tool itself
                        │  PreCompact hook writes a factual timeline ledger
                        │  from the full rollout (backstop, deterministic)
                        ▼
                       clean reset — NO summary anywhere
                        │  AGENTS.md rule: fresh context + own checkpoint = mid-task
                        │  PreToolUse hook denies the first action once:
                        │  "read your checkpoint first"
                        ▼
work continues ───────► model resumes from its own task-directed handoff
```

Numbers (at the July 2026 effective window of 258,400 tokens): hard auto-reset
at 90% (232.5k, the client-side formula `context_window*9/10`), native reminder
45k earlier (~187.6k), a hook fallback nag at 85% in case the native reminder
ever goes missing. All of it scales automatically if OpenAI moves the window.

`"compact first"` typed as a plain message triggers the same flow manually —
which also means it works from surfaces that lack slash commands (e.g. the
phone-to-PC bridge).

Sub-agent lanes each get their own session marker, own checkpoints, and own
cycle; a session-start hook disowns other sessions' leftovers so a fresh
session never "resumes" a stale checkpoint.

## Components

| File | Role |
|---|---|
| `hook/codex-precompaction-hook.mjs` | One script, four hook events: `SessionStart` (issue session marker, disown foreign checkpoints, self-provision FORMAT.md), `PostToolUse` (fallback checkpoint nag at 85%), `PreCompact` (deterministic ledger from the full rollout), `PreToolUse` (post-reset read-gate) |
| `hooks.json.example` | Hook registration for `~/.codex/hooks.json` |
| `config.toml.example` | The `[features.token_budget]` block: flag + reminder threshold + checkpoint-instruction template |
| `AGENTS.md.example` | The `## Context resets` rules: resume-from-checkpoint, user-requested compaction, format reference |
| `docs/FORMAT.md` | The canonical 12-section checkpoint format (the hook auto-writes this into each workspace — the copy here is for reading) |
| `installer/install.mjs`, `install.ps1`, `install.sh` | Cross-platform, idempotent installer with dry-run, backups, conflict detection, and isolated verification |
| `extras/` | Optional: rollout watcher with toast alerts for reasoning-truncation and reset-compliance monitoring (Windows-only), autostart launcher, and a related AGENTS.md section on subagent delegation briefs |

## Install

Requires Node.js 18 or newer in PATH. Preview every change first:

```powershell
# Windows PowerShell
.\install.ps1 --dry-run
.\install.ps1
```

```bash
# Linux / macOS
./install.sh --dry-run
./install.sh
```

The installer targets `$CODEX_HOME` when set, otherwise `~/.codex`. It copies
the hook into `hooks/codex-sane-compaction/`, merges all four registrations
without disturbing unrelated hooks, pins the absolute Node executable used for
installation, adds managed token-budget and AGENTS.md blocks when no equivalent
section already exists, and verifies the complete hook shape and result.
Every changed pre-existing file is copied to a timestamped directory under
`.codex-sane-compaction-backups/` before an atomic write.

If another `codex-precompaction-hook.mjs` is already registered, installation
stops before writing. Review `--dry-run --replace-existing-hook`, then rerun
with `--replace-existing-hook` only when the old registration should be
migrated. Existing unmanaged `token_budget` or `## Context resets` sections
also stop the install before writing; review them and use
`--skip-token-budget` or `--skip-agents` to preserve those layers unchanged.
Use `node installer/install.mjs verify` to recheck a managed installation.
Linked or hard-linked target files are refused rather than silently replacing
dotfile-manager topology.

After installation, **restart the Codex app / CLI** and approve the hook-trust prompt on first
   run — without that approval the hook layers stay dormant (the core
   reminder→checkpoint→reset flow still works; you just lose the marker,
   ledger, and read-gate).

Existing threads pick everything up when resumed after the restart. Artifacts
live in `<workspace>/.codex-precompaction/` — add that to `.gitignore`.

To revert: delete the `[features.token_budget]` table from config.toml.
Compaction returns to stock behavior; the hooks then act as a safety layer on
top of normal summaries and are safe to leave installed.

## Smoke test

Verify the whole loop in a throwaway folder without waiting for a real session
to fill up (~30k tokens):

```bash
mkdir /tmp/tbtest && cd /tmp/tbtest
codex exec -C . --skip-git-repo-check --sandbox workspace-write --color never \
  "Plumbing test, be terse. Do exactly and only: (1) write \
.codex-precompaction/PRECOMPACTION_<your session marker>_T1.md with sections \
PLAN: reset test; STATUS: checkpoint written; NEXT: append the line RESUMED-OK \
to chk.md, then print TEST-COMPLETE. (2) Write chk.md containing CHECKPOINT-ALPHA. \
(3) Call the new_context tool. Nothing else before the reset."
cat chk.md   # expect: CHECKPOINT-ALPHA + RESUMED-OK, output ends TEST-COMPLETE
```

If `chk.md` gains `RESUMED-OK`, the model checkpointed, reset itself with no
summary, and autonomously resumed from its own notes. See
`docs/EXAMPLE_CHECKPOINT.md` for what a real checkpoint should look like.

The hook and installer have a synthetic test suite covering the nag/gate
lifecycle, realistic 17+ KB subagent metadata, parsed native-reminder
suppression, partial-line handling, duplicate compaction records, ledger
numbering, multi-session workspaces, installer backups, conflict handling,
dry-run behavior, and idempotence: `node tests/run-all.mjs`.

Installer tests always pass an explicit isolated `--codex-home`; they never
read or modify the machine's active Codex configuration. CI runs the same suite
on Windows and Linux. The runner prints and retains its uniquely owned artifact
directory instead of recursively cleaning a caller-provided path.

## Tuning

- `reminder_threshold_tokens` (config.toml, default 45000): how early the
  checkpoint reminder fires before the hard reset. Lower = more working context
  per cycle, tighter compliance window.
- `NAG_FILL_RATIO` (hook, default 0.85): fallback nag threshold; keep it above
  the native reminder point and below 0.90 (the reset).
- `RESET_GRACE_MS` (env for the extras watcher, default 180000): how long after
  a reset the compliance monitor waits for a checkpoint read before alerting.

## Provenance

Extracted from a live debugging investigation into Codex compaction behavior
(hallucinated stale incidents after compaction on long game-dev sessions).
The method was developed by **Sol && Fable** — GPT-5.6 Sol living with the
resets on the Codex side, Claude Fable 5 reading the source and wiring the
harness — with the human mostly supplying the failures and the taste.
Key source references, all at `rust-v0.144.0`:

- retention filter: `codex-rs/core/src/compact_remote_v2.rs` (`is_retained_for_remote_compaction_v2` — user/developer/system only, 64k budget cap)
- auto-compact trigger: `codex-rs/protocol/src/openai_models.rs` (`auto_compact_token_limit` = 90% of window)
- summary-free reset: `codex-rs/core/src/compact_token_budget.rs` ("skips model/server summarization and installs a fresh context window instead")
- hook capabilities: `codex-rs/hooks/` (only SessionStart / PreToolUse / PostToolUse / UserPromptSubmit can inject context; PreCompact/PostCompact observe or block)

## If you work on Codex

Everything here is a prosthetic for things the platform could do natively.
The concrete wishlist, cheapest first:

1. **Stabilize `token_budget`.** The flag already implements the right
   architecture (reminder → model-written handoff → summary-free reset).
   This repo is evidence it works in production; it just needs to graduate
   from under-development before an update quietly breaks everyone using it.
2. **Ship a default post-reset resume behavior.** Today the model wakes from a
   `new_context` reset with total amnesia and yields an idle greeting; an
   AGENTS.md rule fixes it, but "read your own handoff file and continue" is
   sane default behavior, not user configuration.
3. **If the summary path stays: anchor it in time.** The current summary is
   tenseless — resolved incidents read as breaking news after compaction.
   Date-stamping events and separating done/pending/in-flight in the summary
   prompt would fix the worst failure mode at zero architectural cost.
4. **Let compaction-adjacent hooks inject context.** `PreCompact`/`PostCompact`
   can only observe or block; the read-gate in this repo has to piggyback on
   `PreToolUse` instead. A `PostCompact` `additionalContext` would make the
   whole recovery path first-class.

## License

MIT — see [LICENSE](LICENSE).
