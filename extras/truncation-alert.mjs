// Live watcher: Windows toast when a Codex turn hits the 518n-2 reasoning
// truncation ladder (516, 1034, 1552, ...). Tails ~/.codex/sessions rollouts.
// Usage: node truncation-alert.mjs [sessionsRoot]   (root override is for testing)
import { watch, statSync, openSync, readSync, closeSync, readdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = process.argv[2] ?? join(process.env.USERPROFILE, '.codex', 'sessions');
const here = dirname(fileURLToPath(import.meta.url));
const logPath = join(here, 'truncation-log.csv');
const compactLogPath = join(here, 'compaction-log.csv');
const offsets = new Map();   // file -> byte offset already consumed
const partial = new Map();   // file -> trailing partial line
const models = new Map();    // file -> last seen model
const seenSig = new Set();   // usage fingerprints (suppresses fork/resume replays)
const lastTc = new Map();    // file -> ts of last token_count (burst suppression)
const lastCkpt = new Map();      // file -> {seq, ts} of last PRECOMPACTION mention (write or read)
const pendingResets = new Map(); // file -> {resetSeq, resetAt, hadCkptBefore, model}
let lineSeq = 0;                 // monotonic across all consumed lines (wall clock can tie within a batch)
const RESET_GRACE_MS = parseInt(process.env.RESET_GRACE_MS, 10) || 180000; // post-reset window for a checkpoint read

const isLadder = r => r > 0 && (r + 2) % 518 === 0;
const isCompaction = j =>
  j.type === 'compacted' || j.payload?.type === 'compacted' ||
  j.payload?.type === 'context_compacted' ||
  j.type === 'ContextCompaction' || j.payload?.type === 'ContextCompaction';

function toast(title, body) {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode('${title.replace(/'/g, "''")}')) | Out-Null
$t.Item(1).AppendChild($x.CreateTextNode('${body.replace(/'/g, "''")}')) | Out-Null
$n = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Codex Truncation Alert').Show($n)`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', detached: true }).unref();
}

function consume(file) {
  let size;
  try { size = statSync(file).size; } catch { return; }
  let off = offsets.get(file);
  if (off == null) { offsets.set(file, size); return; } // first sight: skip history, tail from EOF
  if (size <= off) { if (size < off) offsets.set(file, size); return; }
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - off);
  readSync(fd, buf, 0, buf.length, off);
  closeSync(fd);
  offsets.set(file, size);
  const text = (partial.get(file) ?? '') + buf.toString('utf8');
  const lines = text.split('\n');
  partial.set(file, lines.pop() ?? '');
  for (const line of lines) {
    if (!line.trim()) continue;
    lineSeq++;
    if (line.includes('PRECOMPACTION')) lastCkpt.set(file, { seq: lineSeq, ts: Date.now() });
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'turn_context' && j.payload?.model) models.set(file, j.payload.model);
    if (isCompaction(j) && !pendingResets.has(file)) {
      const now = Date.now();
      const ck = lastCkpt.get(file);
      pendingResets.set(file, {
        resetSeq: lineSeq,
        resetAt: now,
        hadCkptBefore: ck != null && now - ck.ts < 10 * 60000,
        model: models.get(file) ?? 'codex',
      });
    }
    if (j.type !== 'event_msg' || j.payload?.type !== 'token_count') continue;
    const u = j.payload?.info?.last_token_usage;
    const t = j.payload?.info?.total_token_usage;
    if (!u) continue;
    const sig = [u.input_tokens, u.cached_input_tokens, u.output_tokens, u.reasoning_output_tokens, t?.total_tokens].join('|');
    const now = Date.now();
    const burst = now - (lastTc.get(file) ?? 0) < 1000; // replay bursts write many events per second
    lastTc.set(file, now);
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    if (burst) continue;
    const r = u.reasoning_output_tokens;
    if (isLadder(r)) {
      const model = models.get(file) ?? 'codex';
      const short = file.split(/[\\/]/).pop().slice(8, 27);
      const msg = `reasoning cut at ${r} tokens (${model}) — consider re-rolling. session ${short}`;
      console.log(`${new Date().toISOString()} TRUNCATION ${msg}`);
      appendFileSync(logPath, `${new Date().toISOString()},${model},${r},${short}\n`);
      toast('Codex reasoning truncated', msg);
    }
  }
}

// After each reset, a checkpoint read must appear within the grace window; otherwise the
// checkpoint/resume machinery silently failed (hooks dead, feature changed, model ignored it).
function checkResets() {
  const now = Date.now();
  for (const [file, p] of pendingResets) {
    const readAfter = (lastCkpt.get(file)?.seq ?? 0) > p.resetSeq;
    if (readAfter || now - p.resetAt > RESET_GRACE_MS) {
      pendingResets.delete(file);
      const short = file.split(/[\\/]/).pop().slice(8, 27);
      const status = readAfter ? (p.hadCkptBefore ? 'ok' : 'read_after_only') :
        (p.hadCkptBefore ? 'no_read_after' : 'no_checkpoint_flow');
      appendFileSync(compactLogPath, `${new Date().toISOString()},${p.model},${status},${short}\n`);
      if (status !== 'ok') {
        const msg = `context reset without proper checkpoint flow (${status}) in session ${short} (${p.model})`;
        console.log(`${new Date().toISOString()} RESET-ALERT ${msg}`);
        toast('Codex reset compliance', msg);
      }
    }
  }
}

function scan(dir) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith('.jsonl')) consume(p);
  }
}

// single-instance guard: exit quietly if another watcher is already alive
const pidPath = join(here, 'watcher.pid');
try {
  const oldPid = parseInt(readFileSync(pidPath, 'utf8'), 10);
  if (oldPid && oldPid !== process.pid) { process.kill(oldPid, 0); console.log(`already running as pid ${oldPid}, exiting`); process.exit(0); }
} catch { /* stale or missing pid file — proceed */ }
writeFileSync(pidPath, String(process.pid));

console.log(`watching ${root} for 518n-2 truncations...`);
scan(root); // establish EOF offsets
watch(root, { recursive: true }, (_ev, fname) => {
  if (!fname || !fname.endsWith('.jsonl')) return;
  consume(join(root, fname.toString()));
});
setInterval(() => { scan(root); checkResets(); }, 15000); // safety net + reset-compliance sweep
