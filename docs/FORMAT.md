<!-- This file is auto-provisioned into each workspace by the SessionStart hook; this copy is for reading. -->

# Checkpoint format (PRECOMPACTION files)

A checkpoint is the ONLY memory that survives a context reset. Write it from your
full current context, for a reader who knows nothing except this file. Sections:

1. PLAN — the plan you are following, near-verbatim, including anything the user
   just approved or amended.
2. STATUS — done / not done / currently doing. Every "done" item must note how it
   was VERIFIED (test run, diff inspected, in-engine check), not merely written.
3. USER NOTES — corrections, preferences, promises and session-specific
   constraints the user stated (e.g. "don't touch X until Y"). These outrank
   your own preferences after the reset.
4. DECISIONS — key choices with reasons, INCLUDING rejections: "A rejected
   because B — do not retry A". Negative knowledge prevents re-litigating.
5. INCIDENTS — past problems with date-time and resolution status, e.g.
   "app restart 2026-07-12 18:56 — resolved, all lanes respawned". Anything
   listed here is HISTORY; your post-reset self must not treat it as new.
6. POINTERS — commit hashes, branch, key file paths, artifact locations. One
   line each. Never inline file contents; the filesystem survives the reset.
7. IN-FLIGHT — running subagents and their assignments, background processes,
   locks, temporary workarounds. State "none" explicitly if none.
8. NEXT — the exact next action, concretely, including what NOT to redo
   (expensive reruns, re-verification that already passed).
9. WORKING SET — knowledge you already dug up and will need again right after
   the reset: exact file paths with line numbers, symbol/function names, how the
   relevant subsystems behave, commands that worked. Anything you would
   otherwise have to re-search.
10. NOW — the exact action you were performing or about to perform at the
   moment of writing this, and any LIVE user signals: a stop/escape/interruption
   the user just issued, an answer you are waiting for, a correction you have
   acknowledged but not yet applied. User-issued stops and corrections REMAIN IN
   FORCE across the reset — a fresh context or new turn does NOT clear them;
   only the user can.

Rules: no narrative recap and no conversation back-and-forth — record outcomes
and current state only. Date-stamp past events. Keep it under ~150 lines.
Name the file PRECOMPACTION_<your session marker>_<n>.md in this directory.
