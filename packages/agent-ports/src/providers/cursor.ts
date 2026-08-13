// packages/agent-ports/src/providers/cursor.ts
// Port for Cursor chats stored in SQLite:
//   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//     cursorDiskKV:  composerData:<composerId>   → chat metadata JSON (_v …)
//                    bubbleId:<composerId>:<id>  → one message ("bubble") JSON
//                    agentKv:blob:<sha256>       → content-addressed blobs
//                                                  (protobuf/raw — glass agents)
//   ~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/
//     workspace.json → folder path; state.vscdb ItemTable composer.composerData
//     → which composers belong to that folder (our only cwd signal).
//
// IMPORTANT: no official schema, versions churn (_v 10→17 observed).
// Everything here is best-effort: we classify each chat into an era —
//   inline  — conversation array inside composerData (ancient)
//   bubbles — headers + bubbleId rows, fully readable JSON
//   blob    — modern glass agents: conversationState refs plaintext AI-SDK
//             message JSON in agentKv blobs (see blobRefs/mapBlobMessage)
// All three parse; a header with none of them means the body is not local.

import { openSqlite, type SqliteDb } from "../sqlite";
import { mapPool } from "../pool";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FullParseStats,
  PortMessage,
  PortPart,
  PortableSession,
  PortableSessionHead,
} from "../types";

// blob — modern glass format: conversationState ("~" + base64 protobuf) is a
//        list of SHA256 refs into agentKv:blob:<hash>, each a plaintext
//        AI-SDK message JSON {role, content}. Fully recoverable.
export type CursorEra = "inline" | "bubbles" | "blob" | "empty";

export interface CursorScanOptions {
  /** Path to a COPY of state.vscdb (never open the live DB). */
  dbPath: string;
  /** Optional workspaceStorage dir (from a copy or live read-only) for cwd mapping. */
  workspaceStorageDir?: string;
  maxSessions?: number;
}

export interface CursorHead extends PortableSessionHead {
  era: CursorEra;
  composerVersion?: number;
  bubbleCount: number;
}

function decode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return undefined;
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// --- workspaceStorage: composerId → folder ---------------------------------

export async function buildComposerCwdMap(
  workspaceStorageDir: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let hashes: string[];
  try {
    hashes = (await fsp.readdir(workspaceStorageDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return map;
  }
  const copyRoot = await fsp.mkdtemp(join(tmpdir(), "agent-ports-ws-"));
  await mapPool(hashes, 8, async (hash) => {
    const dir = join(workspaceStorageDir, hash);
    let folder: string | undefined;
    try {
      const meta = parseJson(await fsp.readFile(join(dir, "workspace.json"), "utf8"));
      const raw = str(meta?.folder) ?? str(meta?.workspace);
      if (raw?.startsWith("file://")) folder = decodeURIComponent(raw.slice("file://".length));
    } catch {
      return;
    }
    if (!folder) return;
    // Copy the workspace DB before reading — Cursor may hold it open.
    const src = join(dir, "state.vscdb");
    const tmp = join(copyRoot, `${hash}.vscdb`);
    try {
      await fsp.copyFile(src, tmp);
      await fsp.copyFile(`${src}-wal`, `${tmp}-wal`).catch(() => {});
    } catch {
      return;
    }
    try {
      const db = await openSqlite(tmp);
      try {
        const row = db.row("SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
        const data = parseJson(decode(row?.value));
        const all = Array.isArray(data?.allComposers) ? (data!.allComposers as unknown[]) : [];
        for (const entry of all) {
          const id = str((entry as Record<string, unknown>)?.composerId);
          if (id) map.set(id, folder);
        }
      } finally {
        db.close();
      }
    } catch {
      /* workspace DB unreadable — skip */
    } finally {
      await fsp.unlink(tmp).catch(() => {});
      await fsp.unlink(`${tmp}-wal`).catch(() => {});
    }
  });
  await fsp.rm(copyRoot, { recursive: true, force: true }).catch(() => {});
  return map;
}

// --- Scan ------------------------------------------------------------------

interface ComposerRow {
  composerId: string;
  data: Record<string, unknown>;
}

function loadComposers(db: SqliteDb): ComposerRow[] {
  const rows = db.rows("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'") as {
    key: string;
    value: unknown;
  }[];
  const out: ComposerRow[] = [];
  for (const row of rows) {
    const data = parseJson(decode(row.value));
    if (!data) continue;
    out.push({ composerId: row.key.slice("composerData:".length), data });
  }
  return out;
}

/** Non-trivial conversationState → content lives in blob refs. */
function hasBlobState(data: Record<string, unknown>): boolean {
  const cs = data.conversationState;
  return typeof cs === "string" && cs.startsWith("~") && cs.length > 8;
}

function classifyEra(data: Record<string, unknown>, bubbleCount: number): CursorEra {
  const conversation = data.conversation;
  if (Array.isArray(conversation) && conversation.length > 0) return "inline";
  if (bubbleCount > 0) return "bubbles";
  if (hasBlobState(data)) return "blob";
  return "empty";
}

/**
 * Extract 32-byte blob hashes from a "~"+base64 conversationState. The decoded
 * bytes are protobuf with a repeated field #1 (tag 0x0a, wire type 2): each
 * entry is a length-delimited 32-byte sha256. We varint-parse rather than
 * scanning for 0x0a20 so a hash byte can't desync us.
 */
export function blobRefs(conversationState: string): string[] {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(conversationState.slice(1), "base64");
  } catch {
    return [];
  }
  const hashes: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    // Only field #1, wire type 2 carries turn blob refs; bail on anything else.
    if (tag !== 0x0a) break;
    let length = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      length |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (length !== 32 || i + length > bytes.length) break;
    hashes.push(bytes.subarray(i, i + length).toString("hex"));
    i += length;
  }
  return hashes;
}

export async function scan(options: CursorScanOptions): Promise<CursorHead[]> {
  const db = await openSqlite(options.dbPath);
  try {
    const cwdMap = options.workspaceStorageDir
      ? await buildComposerCwdMap(options.workspaceStorageDir)
      : new Map<string, string>();
    const bubbleCounts = new Map<string, number>();
    for (const row of db.rows("SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'") as {
      key: string;
    }[]) {
      const composerId = row.key.split(":")[1];
      if (composerId) bubbleCounts.set(composerId, (bubbleCounts.get(composerId) ?? 0) + 1);
    }

    const stat = await fsp.stat(options.dbPath);
    const heads: CursorHead[] = [];
    for (const { composerId, data } of loadComposers(db)) {
      const bubbleCount = bubbleCounts.get(composerId) ?? 0;
      const era = classifyEra(data, bubbleCount);
      const headers = Array.isArray(data.fullConversationHeadersOnly)
        ? (data.fullConversationHeadersOnly as unknown[])
        : [];
      const inline = Array.isArray(data.conversation) ? (data.conversation as unknown[]) : [];
      const blobCount = era === "blob" ? blobRefs(data.conversationState as string).length : 0;
      heads.push({
        identity: {
          provider: "cursor",
          cwd: cwdMap.get(composerId) ?? "",
          sessionId: composerId,
        },
        sourceFilePath: options.dbPath,
        sourceMtimeMs: num(data.lastUpdatedAt) ?? stat.mtimeMs,
        sourceSizeBytes: stat.size,
        title: str(data.name),
        firstUserPrompt: str(data.text) || undefined,
        lastTimestamp:
          num(data.lastUpdatedAt) !== undefined
            ? new Date(num(data.lastUpdatedAt)!).toISOString()
            : undefined,
        messageCount:
          era === "inline"
            ? inline.length
            : era === "blob"
              ? blobCount
              : Math.max(headers.length, bubbleCount),
        unhandledTypes: [],
        parseErrors: [],
        truncatedHead: false,
        era,
        composerVersion: num(data._v),
        bubbleCount,
      });
    }
    heads.sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs);
    return options.maxSessions ? heads.slice(0, options.maxSessions) : heads;
  } finally {
    db.close();
  }
}

// --- Full parse ------------------------------------------------------------

/** Cursor bubble type enum: 1 = user, 2 = assistant. */
function bubbleRole(type: unknown): "user" | "assistant" | undefined {
  if (type === 1) return "user";
  if (type === 2) return "assistant";
  return undefined;
}

function mapBubble(
  bubble: Record<string, unknown>,
  stats: FullParseStats
): PortMessage | undefined {
  const role = bubbleRole(bubble.type);
  if (!role) {
    stats.skippedRecordTypes[`bubbleType:${String(bubble.type)}`] =
      (stats.skippedRecordTypes[`bubbleType:${String(bubble.type)}`] ?? 0) + 1;
    return undefined;
  }
  const parts: PortPart[] = [];
  const text = str(bubble.text) ?? "";

  const thinking = bubble.thinking as Record<string, unknown> | undefined;
  const thinkingText = str(thinking?.text);
  if (thinkingText) parts.push({ type: "REASONING", text: thinkingText });

  const tfd = bubble.toolFormerData as Record<string, unknown> | undefined;
  // Skip empty tool shells (older bubbles with only additionalData, no real
  // call): they carry neither a name nor arguments and render as noise.
  const tfdHasCall =
    tfd !== undefined &&
    (str(tfd.name) !== undefined ||
      tfd.tool !== undefined ||
      tfd.rawArgs !== undefined ||
      tfd.params !== undefined);
  if (tfd && tfdHasCall) {
    const toolName =
      str(tfd.name) ?? (tfd.tool !== undefined ? `cursor-tool-${String(tfd.tool)}` : "cursor-tool");
    stats.toolNames[toolName] = (stats.toolNames[toolName] ?? 0) + 1;
    let input: unknown = str(tfd.rawArgs) ?? tfd.params;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        /* keep raw */
      }
    }
    let output: unknown = tfd.result;
    if (typeof output === "string") {
      try {
        output = JSON.parse(output);
      } catch {
        /* keep raw */
      }
    }
    const status = str(tfd.status);
    // Unfinished bubble states stay RUNNING so the importer marks them
    // interrupted instead of rendering a phantom success.
    const unfinished =
      status !== undefined && status !== "completed" && status !== "success" && status !== "error";
    parts.push({
      type: "TOOL",
      toolCallId: str(tfd.toolCallId) ?? `bubble-${str(bubble.bubbleId) ?? "?"}`,
      toolName,
      kind: "other",
      state:
        status === "error"
          ? { status: "ERROR", input, error: str(tfd.error) ?? "error" }
          : unfinished
            ? { status: "RUNNING", input }
            : { status: "COMPLETED", input, output },
    });
  }

  if (text) parts.push({ type: "TEXT", text });
  if (parts.length === 0) return undefined;
  return {
    role,
    agentMessageId: str(bubble.bubbleId),
    text: role === "user" ? text : undefined,
    parts,
  };
}

/**
 * Map a modern blob message ({role, content}) in AI-SDK block format:
 *   user      → content string | [{type:'text'}]
 *   assistant → [{type:'text'|'reasoning'|'redacted-reasoning'|'tool-call'}]
 *   tool      → [{type:'tool-result', toolCallId, toolName, result}]
 *   system    → skipped (prompt scaffold)
 * Tool calls register in `pendingTools` by toolCallId; a later tool-result
 * COMPLETES the original part in place (blob records are one message each, so
 * the result arrives in a separate record). Unmatched results become
 * standalone parts and count as unmatchedToolResults.
 */
function mapBlobMessage(
  message: Record<string, unknown>,
  stats: FullParseStats,
  pendingTools: Map<string, Extract<PortPart, { type: "TOOL" }>>
): PortMessage | undefined {
  const role = str(message.role);
  const content = message.content;

  if (role === "system") {
    stats.skippedRecordTypes["blob:system"] = (stats.skippedRecordTypes["blob:system"] ?? 0) + 1;
    return undefined;
  }
  if (role === "user") {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) => str((b as Record<string, unknown>)?.text) ?? "")
              .filter(Boolean)
              .join("\n")
          : "";
    if (!text) return undefined;
    return {
      role: "user",
      text,
      parts: [{ type: "TEXT", text }],
      isMeta: text.startsWith("<user_info>") || text.startsWith("<additional_data>"),
    };
  }
  if (role === "assistant") {
    const parts: PortPart[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        switch (str(b.type)) {
          case "text": {
            const text = str(b.text);
            if (text) parts.push({ type: "TEXT", text });
            break;
          }
          case "reasoning": {
            const text = str(b.text) ?? "";
            if (text) parts.push({ type: "REASONING", text });
            break;
          }
          case "redacted-reasoning":
            parts.push({ type: "REASONING", text: "[redacted]" });
            break;
          case "tool-call": {
            const toolName = str(b.toolName) ?? "unknown";
            stats.toolNames[toolName] = (stats.toolNames[toolName] ?? 0) + 1;
            const part: Extract<PortPart, { type: "TOOL" }> = {
              type: "TOOL",
              toolCallId: str(b.toolCallId) ?? `blob-${stats.records}`,
              toolName,
              kind: "other",
              state: { status: "RUNNING", input: b.args },
            };
            parts.push(part);
            pendingTools.set(part.toolCallId, part);
            break;
          }
          default:
            break;
        }
      }
    } else if (typeof content === "string" && content) {
      parts.push({ type: "TEXT", text: content });
    }
    if (parts.length === 0) return undefined;
    return { role: "assistant", parts };
  }
  if (role === "tool") {
    const parts: PortPart[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (str(b.type) !== "tool-result") continue;
        const toolCallId = str(b.toolCallId);
        const output = b.result ?? b.experimental_content;
        const pending = toolCallId ? pendingTools.get(toolCallId) : undefined;
        if (pending) {
          // Complete the original call in place — no duplicate part, no
          // false "Interrupted" conversion downstream.
          pending.state = { status: "COMPLETED", input: pending.state.input, output };
          pendingTools.delete(toolCallId!);
          continue;
        }
        stats.unmatchedToolResults++;
        parts.push({
          type: "TOOL",
          toolCallId: toolCallId ?? `blob-result-${stats.records}`,
          toolName: str(b.toolName) ?? "unknown",
          kind: "other",
          state: { status: "COMPLETED", output },
        });
      }
    }
    if (parts.length === 0) return undefined;
    // Rare unmatched results still render inline on an assistant-role message.
    return { role: "assistant", parts, isMeta: true };
  }
  stats.skippedRecordTypes[`blob:${role ?? "?"}`] =
    (stats.skippedRecordTypes[`blob:${role ?? "?"}`] ?? 0) + 1;
  return undefined;
}

export async function fullParse(head: CursorHead): Promise<PortableSession> {
  const startedAt = performance.now();
  const stats: FullParseStats = {
    records: 0,
    skippedRecordTypes: {},
    toolNames: {},
    unmatchedToolResults: 0,
    orphanToolCalls: 0,
    sidechainRecords: 0,
    sidechainLinked: 0,
    compactions: 0,
    parseErrors: 0,
    bytes: 0,
    parseMs: 0,
  };
  const messages: PortMessage[] = [];
  const db = await openSqlite(head.sourceFilePath);
  try {
    const row = db.row(
      "SELECT value FROM cursorDiskKV WHERE key = ?",
      `composerData:${head.identity.sessionId}`
    );
    const data = parseJson(decode(row?.value));
    if (!data) {
      stats.parseErrors++;
      return { head, messages, stats: finish(stats, startedAt) };
    }

    if (head.era === "inline") {
      const conversation = Array.isArray(data.conversation) ? (data.conversation as unknown[]) : [];
      for (const entry of conversation) {
        stats.records++;
        const bubble = entry as Record<string, unknown>;
        const message = mapBubble(bubble, stats);
        if (message) messages.push(message);
      }
      return { head, messages, stats: finish(stats, startedAt) };
    }

    if (head.era === "blob") {
      const refs = blobRefs(data.conversationState as string);
      const pendingTools = new Map<string, Extract<PortPart, { type: "TOOL" }>>();
      for (const hash of refs) {
        stats.records++;
        const blobRow = db.row(
          "SELECT value FROM cursorDiskKV WHERE key = ?",
          `agentKv:blob:${hash}`
        );
        const raw = decode(blobRow?.value);
        stats.bytes += raw?.length ?? 0;
        const message = parseJson(raw);
        if (!message) {
          // Non-JSON blob = protobuf turn record (rare) — count, don't crash.
          stats.skippedRecordTypes[raw ? "protobuf-blob" : "missing-blob"] =
            (stats.skippedRecordTypes[raw ? "protobuf-blob" : "missing-blob"] ?? 0) + 1;
          continue;
        }
        const mapped = mapBlobMessage(message, stats, pendingTools);
        if (mapped) messages.push(mapped);
      }
      return { head, messages, stats: finish(stats, startedAt) };
    }

    const headers = Array.isArray(data.fullConversationHeadersOnly)
      ? (data.fullConversationHeadersOnly as unknown[])
      : [];
    for (const entry of headers) {
      stats.records++;
      const bubbleId = str((entry as Record<string, unknown>)?.bubbleId);
      if (!bubbleId) {
        stats.parseErrors++;
        continue;
      }
      const bubbleRow = db.row(
        "SELECT value FROM cursorDiskKV WHERE key = ?",
        `bubbleId:${head.identity.sessionId}:${bubbleId}`
      );
      const raw = decode(bubbleRow?.value);
      stats.bytes += raw?.length ?? 0;
      const bubble = parseJson(raw);
      if (!bubble) {
        // Missing bubble row → this turn lives in an opaque blob (glass agent).
        stats.skippedRecordTypes["missing-bubble"] =
          (stats.skippedRecordTypes["missing-bubble"] ?? 0) + 1;
        continue;
      }
      const message = mapBubble(bubble, stats);
      if (message) messages.push(message);
    }
    return { head, messages, stats: finish(stats, startedAt) };
  } finally {
    db.close();
  }
}

function finish(stats: FullParseStats, startedAt: number): FullParseStats {
  stats.parseMs = performance.now() - startedAt;
  return stats;
}

/** Probe helper: histogram of cursorDiskKV key prefixes (where does data live?). */
export async function keyPrefixHistogram(dbPath: string): Promise<Record<string, number>> {
  const db = await openSqlite(dbPath);
  try {
    const out: Record<string, number> = {};
    for (const row of db.rows("SELECT key FROM cursorDiskKV") as { key: string }[]) {
      const prefix = row.key.split(":")[0];
      out[prefix] = (out[prefix] ?? 0) + 1;
    }
    return out;
  } finally {
    db.close();
  }
}
