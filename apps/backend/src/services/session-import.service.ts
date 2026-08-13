// apps/backend/src/services/session-import.service.ts
// Import sessions from other coding agents (Claude Code / Codex / Cursor) into
// deus.db. Two entry points:
//   - getImportableSessionsSnapshot(): sync, serves the `importable_sessions`
//     WS resource from an in-memory cache and kicks a background rescan when
//     stale; scan completion pushes a fresh snapshot via invalidate().
//   - importExternalSession(): the `importExternalSession` command — full-parses
//     one external session and inserts session/messages/parts idempotently
//     (sessions.origin_key dedupes re-imports).
// Scanning is read-only over other agents' data; Cursor DBs are copied to the
// OS temp dir first (never opened live).

import { homedir, tmpdir } from "node:os";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../lib/database";
import type { QueryParams } from "../lib/query-params";
import { requireParam } from "../lib/query-params";
import { invalidate } from "./query-engine";
import { uuidv7 } from "@shared/lib/uuid";
import type { Part } from "@shared/messages/types";
import type {
  ImportableGroup,
  ImportableSessionDTO,
  ImportableSessionsSnapshot,
} from "@shared/types/session-import";
import {
  claudeCode,
  codex,
  cursor,
  identityKey,
  isDeusOwned,
  matchCwd,
  type KnownRepo,
  type KnownWorkspace,
  type PortMessage,
  type PortableSession,
  type PortableSessionHead,
} from "../../../../packages/agent-ports/src/index";

const SCAN_TTL_MS = 30_000;
const SCAN_MAX_AGE_DAYS = 180;
const MAX_SESSIONS_PER_PROVIDER = 120;
const MAX_TOOL_PAYLOAD_CHARS = 16_384;
const MAX_USER_CONTENT_CHARS = 65_536;

export type { ImportableGroup, ImportableSessionDTO, ImportableSessionsSnapshot };

let snapshot: ImportableSessionsSnapshot = {
  status: "scanning",
  groups: [],
  totals: { "claude-code": 0, codex: 0, cursor: 0 },
};
const headsByKey = new Map<string, PortableSessionHead>();
let lastScanAt = 0;
let scanInFlight: Promise<void> | undefined;

export function getImportableSessionsSnapshot(): ImportableSessionsSnapshot {
  const stale = Date.now() - lastScanAt > SCAN_TTL_MS;
  if (stale && !scanInFlight) {
    scanInFlight = refreshImportableSessions()
      .catch((error) => {
        snapshot = {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          groups: [],
          totals: { "claude-code": 0, codex: 0, cursor: 0 },
        };
      })
      .finally(() => {
        scanInFlight = undefined;
        lastScanAt = Date.now();
        invalidate(["importable_sessions"]);
      });
  }
  return snapshot;
}

async function refreshImportableSessions(): Promise<void> {
  const startedAt = performance.now();
  const home = homedir();
  const logScanFailure = (provider: string) => (error: unknown) => {
    console.warn(`[session-import] ${provider} scan failed:`, error);
    return [];
  };
  const [claudeHeads, codexHeads, cursorHeads] = await Promise.all([
    claudeCode
      .scan({ homeDir: home, maxAgeDays: SCAN_MAX_AGE_DAYS })
      .catch(logScanFailure("claude-code")),
    codex.scan({ homeDir: home, maxAgeDays: SCAN_MAX_AGE_DAYS }).catch(logScanFailure("codex")),
    scanCursor(home).catch(logScanFailure("cursor")),
  ]);

  const db = getDatabase();
  const repos = db.prepare("SELECT id, name, root_path FROM repositories").all() as {
    id: string;
    name: string;
    root_path: string;
  }[];
  const knownRepos: KnownRepo[] = repos.map((r) => ({
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
  }));
  const workspaceRows = db
    .prepare(
      `SELECT w.id, w.repository_id, w.slug, w.title, w.updated_at, r.root_path
       FROM workspaces w JOIN repositories r ON r.id = w.repository_id
       WHERE w.state != 'archived'
       ORDER BY w.updated_at DESC`
    )
    .all() as {
    id: string;
    repository_id: string;
    slug: string;
    title: string | null;
    updated_at: string;
    root_path: string;
  }[];
  const knownWorkspaces: KnownWorkspace[] = workspaceRows.map((w) => ({
    id: w.id,
    repositoryId: w.repository_id,
    path: `${w.root_path}/.deus/${w.slug}`,
    title: w.title ?? undefined,
  }));
  const importedByKey = new Map<string, { sessionId: string }>();
  for (const row of db
    .prepare("SELECT id, origin_key FROM sessions WHERE origin_key IS NOT NULL")
    .all() as { id: string; origin_key: string }[]) {
    importedByKey.set(row.origin_key, { sessionId: row.id });
  }

  headsByKey.clear();
  const sessions: ImportableSessionDTO[] = [];
  const totals = { "claude-code": 0, codex: 0, cursor: 0 };

  const perProvider: [ImportableSessionDTO["provider"], PortableSessionHead[]][] = [
    ["claude-code", claudeHeads],
    ["codex", codexHeads],
    ["cursor", cursorHeads],
  ];
  for (const [provider, heads] of perProvider) {
    let kept = 0;
    for (const head of heads) {
      if (head.messageCount === 0) continue;
      if (isDeusOwned(head, knownWorkspaces)) continue;
      totals[provider]++;
      if (kept >= MAX_SESSIONS_PER_PROVIDER) continue;
      kept++;
      const key = stableKey(head);
      headsByKey.set(key, head);
      const imported = importedByKey.get(key);
      sessions.push({
        key,
        provider,
        title: buildTitle(head),
        cwd: head.identity.cwd,
        lastTimestamp: lastActivityIso(head),
        messageCount: head.messageCount,
        sizeBytes: head.sourceSizeBytes,
        model: head.model,
        imported: imported !== undefined,
        importedSessionId: imported?.sessionId,
        project: matchCwd(head.identity.cwd, knownRepos, knownWorkspaces),
      });
    }
  }

  const scanMs = Math.round(performance.now() - startedAt);
  snapshot = {
    status: "ready",
    scannedAt: new Date().toISOString(),
    scanMs,
    groups: groupSessions(sessions, knownWorkspaces),
    totals,
  };
  console.log(
    `[session-import] scan completed in ${scanMs}ms (claude=${claudeHeads.length} codex=${codexHeads.length} cursor=${cursorHeads.length} listed=${sessions.length})`
  );
}

/** Fire-and-forget cache warmup so the first modal open shows data instantly. */
export function warmImportableSessions(): void {
  getImportableSessionsSnapshot();
}

/**
 * Dedupe identity. Cursor's cwd comes from best-effort workspaceStorage
 * mapping and can change between scans — exclude it from the key there
 * (composerId alone is stable); Claude/Codex read cwd from the transcript
 * itself, where it is intrinsic.
 */
function stableKey(head: PortableSessionHead): string {
  return identityKey({
    ...head.identity,
    cwd: head.identity.provider === "cursor" ? "" : head.identity.cwd,
  });
}

/** Head timestamps come from a bounded prefix read; mtime is authoritative
 *  for "last activity" on transcripts larger than the head window. */
function lastActivityIso(head: PortableSessionHead): string {
  const parsed = head.lastTimestamp ? Date.parse(head.lastTimestamp) : NaN;
  const best = Math.max(Number.isFinite(parsed) ? parsed : 0, head.sourceMtimeMs);
  return new Date(best).toISOString();
}

function buildTitle(head: PortableSessionHead): string {
  const raw = head.title?.trim() || head.firstUserPrompt?.trim() || "";
  const clean = raw.replace(/\s+/g, " ");
  if (clean.length === 0) return `${head.identity.provider} session`;
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
}

function groupSessions(
  sessions: ImportableSessionDTO[],
  workspaces: KnownWorkspace[]
): ImportableGroup[] {
  const byGroup = new Map<string, ImportableGroup>();
  for (const session of sessions) {
    const groupKey =
      session.project.kind === "unknown"
        ? `unknown:${session.project.projectName}:${session.cwd}`
        : `repo:${session.project.repositoryId}`;
    let group = byGroup.get(groupKey);
    if (!group) {
      const repositoryId =
        session.project.kind === "unknown" ? undefined : session.project.repositoryId;
      group = {
        projectName: session.project.projectName,
        kind: session.project.kind,
        repositoryId,
        // Only matched groups get a default target; unmatched sessions must
        // never land in an unrelated workspace (esp. via "Import all").
        defaultWorkspaceId:
          (session.project.kind === "workspace" ? session.project.workspaceId : undefined) ??
          (repositoryId ? workspaces.find((w) => w.repositoryId === repositoryId)?.id : undefined),
        sessions: [],
      };
      byGroup.set(groupKey, group);
    }
    group.sessions.push(session);
  }
  const groups = [...byGroup.values()];
  const latest = (g: ImportableGroup) =>
    g.sessions.reduce((a, s) => Math.max(a, Date.parse(s.lastTimestamp ?? "") || 0), 0);
  for (const group of groups)
    group.sessions.sort(
      (a, b) => (Date.parse(b.lastTimestamp ?? "") || 0) - (Date.parse(a.lastTimestamp ?? "") || 0)
    );
  groups.sort((a, b) => {
    const known = (g: ImportableGroup) => (g.kind === "unknown" ? 1 : 0);
    return known(a) - known(b) || latest(b) - latest(a);
  });
  return groups;
}

const cursorCopyDirs: string[] = [];

/** Cursor user-data dir by platform (macOS / Linux AppImage+deb / Windows). */
function cursorUserDir(home: string): string {
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Cursor", "User");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor", "User");
}

async function scanCursor(home: string): Promise<PortableSessionHead[]> {
  const userDir = cursorUserDir(home);
  const src = join(userDir, "globalStorage", "state.vscdb");
  try {
    await fsp.stat(src);
  } catch {
    return [];
  }
  // Private per-scan dir (mkdtemp): unpredictable path, no clashes. Copies
  // must outlive their scan — imports full-parse from them later, and a stale
  // subscriber can still click rows from the previous snapshot — so keep the
  // current AND previous generation, deleting only older ones.
  const copyDir = await fsp.mkdtemp(join(tmpdir(), "deus-agent-ports-"));
  cursorCopyDirs.push(copyDir);
  while (cursorCopyDirs.length > 2) {
    const stale = cursorCopyDirs.shift()!;
    await fsp.rm(stale, { recursive: true, force: true }).catch(() => {});
  }
  const dbPath = join(copyDir, "cursor-state.vscdb");
  await fsp.copyFile(src, dbPath);
  await fsp.copyFile(`${src}-wal`, `${dbPath}-wal`).catch(() => {});
  const heads = await cursor.scan({
    dbPath,
    workspaceStorageDir: join(userDir, "workspaceStorage"),
  });
  // Same recency window the other providers apply at scan time.
  const minMtime = Date.now() - SCAN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return heads.filter(
    (h) => h.era !== "empty" && h.messageCount > 0 && h.sourceMtimeMs >= minMtime
  );
}

// --- Import ----------------------------------------------------------------

export async function importExternalSession(params: QueryParams): Promise<{
  commandId: string;
  sessionId: string;
  workspaceId: string;
  alreadyImported?: boolean;
}> {
  const key = requireParam(params, "key", "importExternalSession");
  const workspaceId = requireParam(params, "workspaceId", "importExternalSession");
  const db = getDatabase();

  const existing = db
    .prepare("SELECT id, workspace_id FROM sessions WHERE origin_key = ?")
    .get(key) as { id: string; workspace_id: string } | undefined;
  if (existing) {
    return {
      commandId: existing.id,
      sessionId: existing.id,
      workspaceId: existing.workspace_id,
      alreadyImported: true,
    };
  }

  const head = headsByKey.get(key);
  if (!head) throw new Error("Session not found in the current scan — reopen the import dialog");
  const workspace = db.prepare("SELECT id, state FROM workspaces WHERE id = ?").get(workspaceId) as
    | { id: string; state: string }
    | undefined;
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (workspace.state !== "ready")
    throw new Error(`Workspace is not ready (state: ${workspace.state}) — pick another target`);

  const parsed =
    head.identity.provider === "claude-code"
      ? await claudeCode.fullParse(head)
      : head.identity.provider === "codex"
        ? await codex.fullParse(head)
        : await cursor.fullParse(head as Parameters<typeof cursor.fullParse>[0]);

  const importableMessages = parsed.messages.filter((m) => !shouldSkipMessage(m));
  if (importableMessages.length === 0) {
    throw new Error("Nothing to import — the session's content could not be read from the source");
  }

  let sessionId: string;
  try {
    sessionId = insertImportedSession(db, workspaceId, key, head, parsed);
  } catch (error) {
    // Concurrent import of the same key: the UNIQUE origin_key index rejects
    // the losing insert — return the winner's session.
    const winner = db
      .prepare("SELECT id, workspace_id FROM sessions WHERE origin_key = ?")
      .get(key) as { id: string; workspace_id: string } | undefined;
    if (!winner) throw error;
    return {
      commandId: winner.id,
      sessionId: winner.id,
      workspaceId: winner.workspace_id,
      alreadyImported: true,
    };
  }

  markImportedInSnapshot(key, sessionId);
  invalidate(["workspaces", "sessions", "session", "messages", "stats", "importable_sessions"], {
    sessionIds: [sessionId],
  });
  return { commandId: sessionId, sessionId, workspaceId };
}

function markImportedInSnapshot(key: string, sessionId: string): void {
  for (const group of snapshot.groups) {
    for (const session of group.sessions) {
      if (session.key === key) {
        session.imported = true;
        session.importedSessionId = sessionId;
      }
    }
  }
}

function shouldSkipMessage(message: PortMessage): boolean {
  if (!message.isMeta) return false;
  // Meta messages that only carry text (env preambles, hook echoes) are noise;
  // meta carriers of TOOL results / COMPACTION must be kept.
  return message.parts.every((p) => p.type === "TEXT");
}

function insertImportedSession(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
  key: string,
  head: PortableSessionHead,
  parsed: PortableSession
): string {
  const sessionId = uuidv7();
  const provider = head.identity.provider;
  const harness = provider === "codex" ? "codex-sdk" : "claude";
  const agentSessionId = provider === "cursor" ? null : head.identity.sessionId;
  const messages = parsed.messages.filter((m) => !shouldSkipMessage(m));
  const lastUserAt =
    [...messages].reverse().find((m) => m.role === "user" && !m.isMeta)?.sentAt ??
    head.lastTimestamp ??
    null;

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, sent_at, model, agent_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertPart = db.prepare(
    `INSERT INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name, parent_tool_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, agent_harness, agent_session_id, origin_key, title, status, last_user_message_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, datetime('now'))`
    ).run(sessionId, workspaceId, harness, agentSessionId, key, buildTitle(head), lastUserAt);
    // Surface the import: the workspace's chat panel falls back to
    // current_session_id, so the imported conversation is visible on open.
    db.prepare(
      "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, workspaceId);

    for (const message of messages) {
      const messageId = uuidv7();
      const sentAt = message.sentAt ?? head.lastTimestamp ?? null;
      // Compaction markers arrive as meta user messages — store as assistant so
      // the COMPACTION part renders in the transcript flow.
      const role = message.parts.some((p) => p.type !== "TEXT") ? "assistant" : message.role;
      if (role === "user") {
        insertMessage.run(
          messageId,
          sessionId,
          "user",
          capString(message.text ?? "", MAX_USER_CONTENT_CHARS),
          sentAt,
          null,
          null
        );
        continue;
      }
      insertMessage.run(
        messageId,
        sessionId,
        "assistant",
        null,
        sentAt,
        message.model ?? null,
        message.agentMessageId ?? null
      );
      message.parts.forEach((part, index) => {
        const canonical = toCanonicalPart(part, sessionId, messageId, index, sentAt);
        if (!canonical) return;
        insertPart.run(
          canonical.id,
          messageId,
          sessionId,
          index,
          canonical.type,
          JSON.stringify(canonical),
          canonical.type === "TOOL" ? canonical.toolCallId : null,
          canonical.type === "TOOL" ? canonical.toolName : null,
          canonical.parentToolCallId ?? null
        );
      });
    }
  })();

  return sessionId;
}

function toCanonicalPart(
  part: PortableSession["messages"][number]["parts"][number],
  sessionId: string,
  messageId: string,
  partIndex: number,
  sentAt: string | null
): Part | undefined {
  const id = uuidv7();
  const time = sentAt ?? new Date().toISOString();
  switch (part.type) {
    case "TEXT":
      if (part.text.length === 0) return undefined;
      return {
        type: "TEXT",
        id,
        sessionId,
        messageId,
        partIndex,
        text: part.text,
        state: "DONE",
        parentToolCallId: part.parentToolCallId,
      };
    case "REASONING":
      if (part.text.length === 0) return undefined;
      return {
        type: "REASONING",
        id,
        sessionId,
        messageId,
        partIndex,
        text: part.text,
        state: "DONE",
        parentToolCallId: part.parentToolCallId,
      };
    case "TOOL": {
      const input = capJson(part.state.input);
      const state =
        part.state.status === "COMPLETED"
          ? {
              status: "COMPLETED" as const,
              input,
              output: capJson(part.state.output),
              time: { start: time, end: time },
            }
          : part.state.status === "ERROR"
            ? {
                status: "ERROR" as const,
                input,
                error: capString(part.state.error ?? "Tool failed", MAX_TOOL_PAYLOAD_CHARS),
                time: { start: time, end: time },
              }
            : {
                // RUNNING in a finished transcript = interrupted; ERROR renders
                // honestly instead of an eternal spinner.
                status: "ERROR" as const,
                input,
                error: "Interrupted — imported before the tool finished",
                time: { start: time, end: time },
              };
      return {
        type: "TOOL",
        id,
        sessionId,
        messageId,
        partIndex,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        kind: part.kind,
        state,
        parentToolCallId: part.parentToolCallId,
      };
    }
    case "COMPACTION":
      return { type: "COMPACTION", id, sessionId, messageId, partIndex, auto: part.auto };
    default:
      return undefined;
  }
}

function capString(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… [truncated on import]` : value;
}

function capJson(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return capString(value, MAX_TOOL_PAYLOAD_CHARS);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return String(value).slice(0, MAX_TOOL_PAYLOAD_CHARS);
  }
  if (text.length <= MAX_TOOL_PAYLOAD_CHARS) return value;
  return { truncated: true, preview: `${text.slice(0, MAX_TOOL_PAYLOAD_CHARS)}…` };
}
