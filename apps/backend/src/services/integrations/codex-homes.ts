// backend/src/services/integrations/codex-homes.ts
// Codex session homes.
//
// The engine gives Codex a turn's MCP servers only in a CODEX_HOME of the
// session's own (it writes them into that home's config, never ~/.codex).
// Codex itself takes them in a thread's `config` with no home at all
// (thread/start and thread/resume, 0.160); once the engine delivers them
// that way, this file goes.

import fs from "fs";
import os from "os";
import path from "path";
import { DB_PATH, getDatabase } from "../../lib/database";

/** The user's own Codex home (never written by Deus). */
function userCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexHomesRoot(): string {
  return path.join(path.dirname(DB_PATH), "codex-homes");
}

const HOME_MARKER = ".deus-codex-home";

/**
 * What a session home shares with the user's: their login, instructions and
 * skills. Not their history: a fresh home indexes every linked rollout into
 * its own state database before it answers `initialize`, which outlasts the
 * engine's startup timeout on a long history. The session's own threads live
 * in its home, which every later turn of the session reuses.
 */
const SHARED_ENTRIES = ["auth.json", "AGENTS.md", "prompts", "skills"];

/**
 * Link what the user's home has and this one lacks. At each use, not only
 * when the home is made: a login the person makes after a chat's first turn
 * reaches that chat.
 */
function linkShared(home: string): void {
  const shared = userCodexHome();
  for (const entry of SHARED_ENTRIES) {
    const target = path.join(shared, entry);
    const link = path.join(home, entry);
    if (!fs.existsSync(target) || fs.lstatSync(link, { throwIfNoEntry: false })) continue;
    fs.symlinkSync(target, link);
  }
}

/**
 * The CODEX_HOME for a Deus session's Codex turns that carry apps. Created
 * once per session; later turns reuse it (and the engine keeps its MCP
 * servers current there). A session whose thread began in the user's own
 * home has its history there, so it keeps that home and runs without apps.
 */
export function codexSessionHome(sessionId: string): string {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  const home = path.join(codexHomesRoot(), sessionId);
  const marker = path.join(home, HOME_MARKER);
  if (fs.existsSync(marker)) {
    // Its last use: an idle home's caches are trimmed (`pruneCodexSessionHomes`).
    const now = new Date();
    fs.utimesSync(marker, now, now);
    linkShared(home);
    return home;
  }
  // The engine writes the turn's MCP servers into this folder's config: the user's only.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  linkShared(home);
  // A copy, not a link: the engine rewrites `mcp_servers` in this file.
  const config = path.join(userCodexHome(), "config.toml");
  if (fs.existsSync(config)) fs.copyFileSync(config, path.join(home, "config.toml"));
  fs.writeFileSync(path.join(home, HOME_MARKER), `${sessionId}\n`);
  return home;
}

/** Whether a session already runs Codex in a home of its own (keep using it). */
function hasCodexSessionHome(sessionId: string): boolean {
  return fs.existsSync(path.join(codexHomesRoot(), sessionId, HOME_MARKER));
}

/** What Codex downloads into every home and downloads again when missing (about 120 MB). */
const REGENERABLE = ["cache", "plugins", "tmp", "shell_snapshots"];
/** A home unused this long gives its regenerable caches back. */
const IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The CODEX_HOME a Codex turn runs in, or null for the user's own. A chat
 * gets a home of its own at its first turn once an app is installed, ready
 * or not, switched on or not (one signed in to or switched on later reaches
 * the same chat), and keeps it. With
 * no app installed it stays in the user's home, where their own Codex finds
 * it; a thread that began there resumes there, without apps.
 */
export function codexTurnHome(
  sessionId: string,
  turn: { resumes: boolean; appsInstalled: boolean }
): string | null {
  if (!hasCodexSessionHome(sessionId) && (turn.resumes || !turn.appsInstalled)) return null;
  return codexSessionHome(sessionId);
}

/**
 * Keep the session homes small. A home is the only copy of its session's
 * Codex thread, so it stays as long as its session exists (sessions are
 * archived, not deleted, and an archived one can be resumed). What goes:
 * the whole home of a session that no longer exists, and Codex's own
 * regenerable caches from a home nothing has used for three days.
 * Returns how many homes it removed or trimmed.
 */
export function pruneCodexSessionHomes(): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(codexHomesRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  const candidates = entries.filter(
    (entry) =>
      entry.isDirectory() && fs.existsSync(path.join(codexHomesRoot(), entry.name, HOME_MARKER))
  );
  if (candidates.length === 0) return 0;
  const exists = getDatabase().prepare("SELECT 1 FROM sessions WHERE id = ?");
  let touched = 0;
  for (const entry of candidates) {
    const home = path.join(codexHomesRoot(), entry.name);
    if (!exists.get(entry.name)) {
      // Its links only point at the user's files; removing them removes nothing of theirs.
      fs.rmSync(home, { recursive: true, force: true });
      touched += 1;
      continue;
    }
    if (Date.now() - fs.statSync(path.join(home, HOME_MARKER)).mtimeMs < IDLE_MS) continue;
    let trimmed = false;
    for (const name of REGENERABLE) {
      const target = path.join(home, name);
      // Only real folders: `skills` and the rest are links to the user's own.
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
        fs.rmSync(target, { recursive: true, force: true });
        trimmed = true;
      }
    }
    if (trimmed) touched += 1;
  }
  return touched;
}
