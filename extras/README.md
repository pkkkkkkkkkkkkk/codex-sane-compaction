# Extras (optional, Windows-only)

## truncation-alert.mjs

Long-running watcher that tails `~/.codex/sessions` rollouts and raises Windows
toast notifications for two conditions:

1. **Reasoning truncation** — turns whose reasoning ends exactly on the
   518n−2 ladder (516, 1034, 1552, ...), a server-side early-exit anomaly that
   correlates with degraded answers (see openai/codex#30364). Logged to
   `truncation-log.csv`.
2. **Reset compliance** — every context reset is checked for a checkpoint
   written before it and read after it. Every reset gets a row in
   `compaction-log.csv` (`ok` / `no_read_after` / `read_after_only` /
   `no_checkpoint_flow`); non-ok raises a toast. This is the canary that tells
   you the checkpoint machinery silently broke (e.g. after a Codex update).

Run: `node truncation-alert.mjs` (single-instance guarded via `watcher.pid`).
Grace window for the compliance check: `RESET_GRACE_MS` env, default 180000 ms.

`compaction-log.csv` doubles as tuning data: reset frequency and compliance
rate over time tell you whether to move `reminder_threshold_tokens`.

## start-watcher.vbs.example

Hidden autostart launcher. Fix the path, then drop a copy into
`shell:startup`. Output goes to `watcher.log` next to the script.
