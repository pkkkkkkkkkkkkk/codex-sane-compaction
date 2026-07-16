# Checkpoint format (PRECOMPACTION files)

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

After a reset: if reality (tooling limits, code structure, gate failures)
pushes against TASK Meaning, re-read TASK Quote and Why before adapting —
extending the tooling may BE the task. A requirement does not shrink because
the current code cannot express it yet.
