// apps/backend/src/services/aap/pid-journal.ts
// Append-only PID journal for cross-restart orphan cleanup.
//
// Why this exists: when the backend dies ungracefully (SIGKILL, OOM, crash,
// power loss), no shutdown handler runs. Child processes spawned with
// `detached: false` can survive — macOS/Linux don't auto-SIGHUP GUI-spawned
// subprocesses when the parent dies (orphans get reparented to launchd/init).
// Without cleanup, every ungraceful quit leaks a device-use Bun process.
//
// Design: one pid per line, appended on spawn, read + swept + cleared on
// backend boot. No remove-on-graceful-exit — relying on the next-boot sweep
// to find the now-dead pids (kill -0 returns false) and silently clear them.
// Single writer, small writes (`<8 bytes`), concurrent-safe via POSIX
// appendFile atomicity.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import { resolveDefaultDataDir } from "@shared/runtime";

function defaultJournalPath(): string {
  const dir = resolveDefaultDataDir({
    platform: process.platform,
    homeDir: process.env.HOME ?? os.homedir(),
    appData: process.env.APPDATA,
    xdgDataHome: process.env.XDG_DATA_HOME,
  });
  return join(dir, "aap-pids.txt");
}

/** Override via env for tests. Prod uses the data-dir default. */
function getJournalPath(): string {
  return process.env.DEUS_AAP_PID_JOURNAL ?? defaultJournalPath();
}

/** Append a PID to the journal. Silently logs on failure — journal miss is
 *  never fatal (worst case: an orphan slips through one sweep cycle). */
export function recordPid(pid: number): void {
  try {
    const path = getJournalPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${pid}\n`, "utf8");
  } catch (err) {
    console.warn("[AAP-Journal] failed to record pid", pid, err);
  }
}

/** Read the journal, returning all valid pids. Missing file = []. */
export function readPids(): number[] {
  try {
    const content = readFileSync(getJournalPath(), "utf8");
    return content
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/** Truncate the journal. Called after a successful sweep. */
export function clearPids(): void {
  try {
    writeFileSync(getJournalPath(), "", "utf8");
  } catch (err) {
    console.warn("[AAP-Journal] failed to clear journal", err);
  }
}

/** Exposed for diagnostics + tests. */
export function journalPath(): string {
  return getJournalPath();
}
