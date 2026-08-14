// packages/agent-ports/src/providers/claude-code.ts
// Port for Claude Code CLI transcripts: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
//
// Design notes (mirrors what Cursor's claude-code-import does, with fixes):
// - Listing never reads whole files: adaptive head-parse (64KB → ×4 → 4MB).
// - We match sessions by the `cwd` field parsed from records, NOT by deriving
//   the directory slug from a cwd (Claude Code's slug replaces "." and "_" too,
//   which Cursor's replaceAll("/", "-") derivation gets wrong).
// - Full parse pairs tool_use → tool_result by id, groups streamed assistant
//   records by message.id, links sidechain (subagent) chains to their Task
//   tool call by prompt-matching, and turns compact summaries into COMPACTION.

import { createReadStream, promises as fsp } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { mapPool } from "../pool";
import type {
  FullParseStats,
  PortMessage,
  PortPart,
  PortToolKind,
  PortableSession,
  PortableSessionHead,
  ScanOptions,
} from "../types";

const HEAD_INITIAL_BYTES = 64 * 1024;
const HEAD_MAX_BYTES = 4 * 1024 * 1024;
const HEAD_GROWTH = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// Record types we understand but deliberately do not surface as messages.
const AUX_RECORD_TYPES = new Set([
  "summary",
  "attachment",
  "queue-operation",
  "last-prompt",
  "file-history-snapshot",
  "progress",
  "todo",
  "ai-title",
  "system",
  "pr-link",
  "mode",
  "permission-mode",
]);

export function projectsDir(homeDir: string): string {
  return join(homeDir, ".claude", "projects");
}

async function* lines(filePath: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const v = JSON.parse(trimmed);
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

/** Extract visible text from a user record's message.content (string or blocks). */
function userText(record: Record<string, unknown>): string | undefined {
  const message = record.message as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) texts.push(b.text);
  }
  return texts.length ? texts.join("\n") : undefined;
}

/** Base64 image blocks from a user record's message.content (pasted images). */
function userImageBlocks(record: Record<string, unknown>): unknown[] {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => {
    if (typeof block !== "object" || block === null) return false;
    const b = block as Record<string, unknown>;
    if (b.type !== "image") return false;
    const source = b.source as Record<string, unknown> | undefined;
    return source?.type === "base64" && typeof source.data === "string";
  });
}

/** Meta user content we hide by default (hooks, command echoes, reminders). */
function isMetaUserText(text: string): boolean {
  return (
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<system-reminder>") ||
    text.startsWith("Caveat: The messages below were generated")
  );
}

export function toolKind(name: string): PortToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Read":
    case "NotebookRead":
    case "LS":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "write";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "bash";
    case "Grep":
    case "Glob":
    case "WebSearch":
    case "WebFetch":
      return "search";
    case "Task":
    case "Agent":
      return "task";
    default:
      return "other";
  }
}

// --- Head parse ------------------------------------------------------------

interface HeadFields {
  sessionId?: string;
  cwd?: string;
  firstUserPrompt?: string;
  summaryTitle?: string;
  lastTimestamp?: string;
  messageCount: number;
  unhandledTypes: Set<string>;
  parseErrors: { lineNumber: number; message: string }[];
}

function parseHeadText(text: string): HeadFields {
  const out: HeadFields = {
    messageCount: 0,
    unhandledTypes: new Set(),
    parseErrors: [],
  };
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const record = parseLine(rawLines[i]);
    if (record === undefined) {
      if (rawLines[i].trim().length > 0)
        out.parseErrors.push({ lineNumber: i + 1, message: "invalid JSON" });
      continue;
    }
    const type = str(record.type);
    out.sessionId ??= str(record.sessionId);
    out.cwd ??= str(record.cwd);
    out.lastTimestamp = str(record.timestamp) ?? out.lastTimestamp;
    if (type === "user" || type === "assistant") out.messageCount++;
    if (type === "summary") out.summaryTitle ??= str(record.summary);
    if (type === "ai-title") out.summaryTitle = str(record.aiTitle) ?? out.summaryTitle;
    if (type === "user" && record.isMeta !== true && !record.isSidechain) {
      const text = userText(record);
      // Title pick: skip injected XML-ish preambles (<system_instruction>…)
      if (text && !isMetaUserText(text) && !text.startsWith("<")) out.firstUserPrompt ??= text;
    }
    if (type && type !== "user" && type !== "assistant" && !AUX_RECORD_TYPES.has(type))
      out.unhandledTypes.add(type);
  }
  return out;
}

async function readHead(
  filePath: string,
  maxBytes: number
): Promise<{ text: string; hitLimit: boolean }> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const hitLimit = bytesRead === maxBytes;
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (hitLimit) {
      // Drop the trailing partial line.
      const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
      text = cut === -1 ? "" : text.slice(0, cut);
    }
    return { text, hitLimit };
  } finally {
    await handle.close();
  }
}

export async function headParse(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number
): Promise<PortableSessionHead> {
  let budget = HEAD_INITIAL_BYTES;
  let fields: HeadFields;
  let truncated: boolean;
  for (;;) {
    const { text, hitLimit } = await readHead(filePath, budget);
    truncated = hitLimit;
    fields = parseHeadText(text);
    if (fields.cwd !== undefined || !hitLimit || budget >= HEAD_MAX_BYTES) break;
    budget = Math.min(budget * HEAD_GROWTH, HEAD_MAX_BYTES);
  }
  const fileSessionId = filePath
    .split("/")
    .at(-1)!
    .replace(/\.jsonl$/, "");
  return {
    identity: {
      provider: "claude-code",
      cwd: fields.cwd ?? "",
      sessionId: fields.sessionId ?? fileSessionId,
    },
    sourceFilePath: filePath,
    sourceMtimeMs: mtimeMs,
    sourceSizeBytes: sizeBytes,
    title: fields.summaryTitle,
    firstUserPrompt: fields.firstUserPrompt,
    lastTimestamp: fields.lastTimestamp,
    messageCount: fields.messageCount,
    unhandledTypes: [...fields.unhandledTypes].sort(),
    parseErrors: fields.parseErrors,
    truncatedHead: truncated,
  };
}

// --- Scan ------------------------------------------------------------------

export async function scan(options: ScanOptions): Promise<PortableSessionHead[]> {
  const root = projectsDir(options.homeDir);
  let dirs: string[];
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
  const minMtime = options.maxAgeDays !== undefined ? Date.now() - options.maxAgeDays * DAY_MS : 0;
  const candidates: { filePath: string; mtimeMs: number; size: number }[] = [];
  await mapPool(dirs, 16, async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = join(dir, entry.name);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs >= minMtime && stat.size > 0)
          candidates.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        /* unreadable — skip */
      }
    }
  });
  // Per-file resilience: one vanished/corrupt transcript must not blank the
  // whole provider scan.
  const heads = (
    await mapPool(candidates, 16, async (c) => {
      try {
        return await headParse(c.filePath, c.mtimeMs, c.size);
      } catch {
        return undefined;
      }
    })
  ).filter((h): h is PortableSessionHead => h !== undefined);
  let result = heads;
  if (options.cwdFilters?.length) {
    result = result.filter((h) =>
      options.cwdFilters!.some((prefix) => h.identity.cwd.startsWith(prefix))
    );
  }
  result.sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs);
  return options.maxSessions ? result.slice(0, options.maxSessions) : result;
}

// --- Full parse ------------------------------------------------------------

interface PendingTool {
  part: Extract<PortPart, { type: "TOOL" }>;
  /** For Task tools: the prompt, used to link sidechain roots. */
  taskPrompt?: string;
}

export async function fullParse(head: PortableSessionHead): Promise<PortableSession> {
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
    bytes: head.sourceSizeBytes,
    parseMs: 0,
  };
  const messages: PortMessage[] = [];
  const pendingTools = new Map<string, PendingTool>();
  // Sidechain linking: record uuid → owning Task toolCallId.
  const sidechainOwner = new Map<string, string>();
  const unclaimedTasks: { toolCallId: string; prompt: string }[] = [];
  let currentAssistant: { message: PortMessage; apiMessageId: string } | undefined;

  const flushAssistant = () => {
    currentAssistant = undefined;
  };

  for await (const line of lines(head.sourceFilePath)) {
    const record = parseLine(line);
    if (record === undefined) {
      if (line.trim().length > 0) stats.parseErrors++;
      continue;
    }
    stats.records++;
    const type = str(record.type);
    const uuid = str(record.uuid);
    const parentUuid = str(record.parentUuid);
    const isSidechain = record.isSidechain === true;
    if (isSidechain) stats.sidechainRecords++;

    // Resolve sidechain ownership by walking parent links.
    let parentToolCallId: string | undefined;
    if (isSidechain && uuid) {
      const inherited = parentUuid ? sidechainOwner.get(parentUuid) : undefined;
      if (inherited) {
        sidechainOwner.set(uuid, inherited);
        parentToolCallId = inherited;
      }
    }

    if (type === "user") {
      flushAssistant();
      const text = userText(record);

      // Sidechain roots: match against unclaimed Task prompts.
      if (isSidechain && uuid && !parentToolCallId && text) {
        const idx = unclaimedTasks.findIndex((t) => t.prompt === text || text.startsWith(t.prompt));
        if (idx !== -1) {
          const task = unclaimedTasks.splice(idx, 1)[0];
          sidechainOwner.set(uuid, task.toolCallId);
          parentToolCallId = task.toolCallId;
        }
      }
      if (isSidechain && parentToolCallId) stats.sidechainLinked++;

      // Tool results ride on user records.
      const message = record.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        // record.toolUseResult is record-level: only trust it when the record
        // carries exactly one tool_result (parallel calls share one record).
        const resultBlocks = content.filter(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "tool_result"
        ).length;
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b.type !== "tool_result") continue;
          const toolUseId = str(b.tool_use_id);
          const pending = toolUseId ? pendingTools.get(toolUseId) : undefined;
          if (!pending) {
            stats.unmatchedToolResults++;
            continue;
          }
          pendingTools.delete(toolUseId!);
          const isError = b.is_error === true;
          // Prefer the structured toolUseResult on the record over raw blocks.
          const output = resultBlocks === 1 ? (record.toolUseResult ?? b.content) : b.content;
          pending.part.state = isError
            ? { status: "ERROR", input: pending.part.state.input, error: flattenResult(b.content) }
            : { status: "COMPLETED", input: pending.part.state.input, output };
        }
      }

      if (record.isCompactSummary === true) {
        stats.compactions++;
        messages.push({
          role: "user",
          sentAt: str(record.timestamp),
          parts: [{ type: "COMPACTION", auto: true, summary: text?.slice(0, 2000) }],
          isMeta: true,
        });
        continue;
      }
      const imageBlocks = userImageBlocks(record);
      if (text !== undefined || imageBlocks.length > 0) {
        const bodyText = text ?? "";
        const meta = record.isMeta === true || (text !== undefined && isMetaUserText(text));
        messages.push({
          role: "user",
          sentAt: str(record.timestamp),
          text: bodyText,
          // Mixed/image-only prompts carry the full block list so the UI can
          // render exactly what the agent was shown.
          contentBlocks:
            imageBlocks.length > 0
              ? [...(bodyText ? [{ type: "text", text: bodyText }] : []), ...imageBlocks]
              : undefined,
          parts: [{ type: "TEXT", text: bodyText, parentToolCallId }],
          isMeta: meta || isSidechain,
        });
      }
      continue;
    }

    if (type === "assistant") {
      const message = record.message as Record<string, unknown> | undefined;
      const apiMessageId = str(message?.id) ?? uuid ?? String(stats.records);
      if (!currentAssistant || currentAssistant.apiMessageId !== apiMessageId) {
        const next: PortMessage = {
          role: "assistant",
          agentMessageId: apiMessageId,
          sentAt: str(record.timestamp),
          model: str(message?.model),
          parts: [],
          isMeta: isSidechain,
        };
        messages.push(next);
        currentAssistant = { message: next, apiMessageId };
      }
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        switch (b.type) {
          case "text": {
            const text = str(b.text);
            if (text) currentAssistant.message.parts.push({ type: "TEXT", text, parentToolCallId });
            break;
          }
          case "thinking": {
            const text = str(b.thinking) ?? "";
            currentAssistant.message.parts.push({ type: "REASONING", text, parentToolCallId });
            break;
          }
          case "redacted_thinking":
            currentAssistant.message.parts.push({
              type: "REASONING",
              text: "[redacted]",
              parentToolCallId,
            });
            break;
          case "tool_use": {
            const toolCallId =
              str(b.id) ?? `${apiMessageId}:${currentAssistant.message.parts.length}`;
            const toolName = str(b.name) ?? "unknown";
            stats.toolNames[toolName] = (stats.toolNames[toolName] ?? 0) + 1;
            const part: Extract<PortPart, { type: "TOOL" }> = {
              type: "TOOL",
              toolCallId,
              toolName,
              kind: toolKind(toolName),
              state: { status: "RUNNING", input: b.input },
              parentToolCallId,
            };
            currentAssistant.message.parts.push(part);
            const pending: PendingTool = { part };
            if (toolKind(toolName) === "task") {
              const input = b.input as Record<string, unknown> | undefined;
              const prompt = str(input?.prompt);
              if (prompt) unclaimedTasks.push({ toolCallId, prompt });
            }
            pendingTools.set(toolCallId, pending);
            break;
          }
          default:
            break;
        }
      }
      continue;
    }

    if (type !== undefined) {
      stats.skippedRecordTypes[type] = (stats.skippedRecordTypes[type] ?? 0) + 1;
    }
  }

  stats.orphanToolCalls = [...pendingTools.values()].filter(
    (p) => p.part.state.status === "RUNNING"
  ).length;
  stats.parseMs = performance.now() - startedAt;
  return { head, messages, stats };
}

function flattenResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : ""
    )
    .filter(Boolean)
    .join("\n");
}
