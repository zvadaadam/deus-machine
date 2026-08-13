// packages/agent-ports/src/providers/codex.ts
// Port for Codex CLI / IDE rollout files:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//
// Every line is {timestamp, type, payload}. `session_meta` (first line) carries
// {id, cwd, originator, source, model_provider…}. Durable conversation content
// lives in `response_item` payloads (message / reasoning / function_call /
// function_call_output / local_shell_call / custom_tool_call / web_search_call…);
// `event_msg` is ephemeral UI telemetry we only mine for token usage. Unlike
// Claude Code there is no per-project directory — we scan by date and filter on
// session_meta.cwd.

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

const HEAD_BYTES = 128 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function sessionsDir(homeDir: string): string {
  return join(homeDir, ".codex", "sessions");
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

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = obj(block);
      if (!b) return "";
      if (b.type === "input_text" || b.type === "output_text" || b.type === "text")
        return str(b.text) ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Codex wraps environment/instruction preamble as user messages — hide them. */
function isMetaUserText(text: string): boolean {
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<turn_context>") ||
    text.startsWith("<ide_context>") ||
    text.startsWith("# AGENTS.md") ||
    text.startsWith("<repo_instructions>") ||
    text.startsWith("<recommended_plugins>") ||
    text.startsWith("<user_shell>") ||
    text.startsWith("<collaboration_mode>")
  );
}

export function toolKind(name: string): PortToolKind {
  if (name.startsWith("mcp__") || name.includes("/")) return "mcp";
  switch (name) {
    case "shell":
    case "shell_command":
    case "local_shell":
    case "exec_command":
    case "container.exec":
      return "bash";
    case "apply_patch":
      return "write";
    case "read_file":
    case "list_dir":
    case "view_image":
      return "read";
    case "grep":
    case "find":
    case "web_search":
    case "search":
      return "search";
    default:
      return "other";
  }
}

// --- Head parse ------------------------------------------------------------

export async function headParse(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number
): Promise<PortableSessionHead> {
  const handle = await fsp.open(filePath, "r");
  let text: string;
  let hitLimit: boolean;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    hitLimit = bytesRead === HEAD_BYTES;
    text = buffer.subarray(0, bytesRead).toString("utf8");
    if (hitLimit) {
      const cut = text.lastIndexOf("\n");
      text = cut === -1 ? "" : text.slice(0, cut);
    }
  } finally {
    await handle.close();
  }

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let originator: string | undefined;
  let source: string | undefined;
  let firstUserPrompt: string | undefined;
  let lastTimestamp: string | undefined;
  let messageCount = 0;
  const unhandled = new Set<string>();
  const parseErrors: { lineNumber: number; message: string }[] = [];

  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const record = parseLine(rawLines[i]);
    if (record === undefined) {
      if (rawLines[i].trim().length > 0)
        parseErrors.push({ lineNumber: i + 1, message: "invalid JSON" });
      continue;
    }
    const type = str(record.type);
    const payload = obj(record.payload);
    lastTimestamp = str(record.timestamp) ?? lastTimestamp;
    if (type === "session_meta" && payload) {
      sessionId ??= str(payload.id);
      cwd ??= str(payload.cwd);
      model ??= str(payload.model) ?? str(payload.model_provider);
      originator ??= str(payload.originator);
      source ??= str(payload.source);
    } else if (type === "turn_context" && payload) {
      cwd ??= str(payload.cwd);
      model = str(payload.model) ?? model;
    } else if (type === "response_item" && payload) {
      const itemType = str(payload.type);
      if (itemType === "message") {
        const role = str(payload.role);
        if (role === "user" || role === "assistant") {
          messageCount++;
          if (role === "user" && firstUserPrompt === undefined) {
            const t = contentText(payload.content);
            if (t && !isMetaUserText(t) && !t.startsWith("<")) firstUserPrompt = t;
          }
        }
      }
    } else if (
      type !== undefined &&
      !["session_meta", "turn_context", "response_item", "event_msg", "compacted"].includes(type)
    ) {
      unhandled.add(type);
    }
  }

  const fileId = filePath
    .split("/")
    .at(-1)!
    .replace(/\.jsonl$/, "");
  return {
    identity: { provider: "codex", cwd: cwd ?? "", sessionId: sessionId ?? fileId },
    sourceFilePath: filePath,
    sourceMtimeMs: mtimeMs,
    sourceSizeBytes: sizeBytes,
    firstUserPrompt,
    lastTimestamp,
    messageCount,
    model,
    extra:
      originator || source ? { originator: originator ?? "?", source: source ?? "?" } : undefined,
    unhandledTypes: [...unhandled].sort(),
    parseErrors,
    truncatedHead: hitLimit,
  };
}

// --- Scan ------------------------------------------------------------------

export async function scan(options: ScanOptions): Promise<PortableSessionHead[]> {
  const root = sessionsDir(options.homeDir);
  const files: { path: string; mtimeMs: number; size: number }[] = [];
  const minMtime = options.maxAgeDays !== undefined ? Date.now() - options.maxAgeDays * DAY_MS : 0;

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fsp.stat(full);
          if (stat.mtimeMs >= minMtime && stat.size > 0)
            files.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  }
  await walk(root, 0);

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Per-file resilience: one vanished/corrupt rollout must not blank the scan.
  const parsed = (
    await mapPool(files, 16, async (file) => {
      try {
        return await headParse(file.path, file.mtimeMs, file.size);
      } catch {
        return undefined;
      }
    })
  ).filter((h): h is PortableSessionHead => h !== undefined);
  const heads: PortableSessionHead[] = [];
  for (const head of parsed) {
    if (options.cwdFilters?.length) {
      if (!options.cwdFilters.some((prefix) => head.identity.cwd.startsWith(prefix))) continue;
    }
    heads.push(head);
    if (options.maxSessions && heads.length >= options.maxSessions) break;
  }
  return heads;
}

// --- Full parse ------------------------------------------------------------

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
  const pendingByCallId = new Map<string, Extract<PortPart, { type: "TOOL" }>>();
  let model: string | undefined;
  let currentAssistant: PortMessage | undefined;

  const assistant = (ts?: string): PortMessage => {
    if (!currentAssistant) {
      // Stamp the creating record's timestamp so tool/reasoning-only turns
      // keep real chronology (head.lastTimestamp is a bounded-prefix value).
      currentAssistant = { role: "assistant", model, sentAt: ts, parts: [] };
      messages.push(currentAssistant);
    } else if (ts && !currentAssistant.sentAt) {
      currentAssistant.sentAt = ts;
    }
    return currentAssistant;
  };

  const skip = (label: string) => {
    stats.skippedRecordTypes[label] = (stats.skippedRecordTypes[label] ?? 0) + 1;
  };

  for await (const line of lines(head.sourceFilePath)) {
    const record = parseLine(line);
    if (record === undefined) {
      if (line.trim().length > 0) stats.parseErrors++;
      continue;
    }
    stats.records++;
    const type = str(record.type);
    const payload = obj(record.payload);
    const timestamp = str(record.timestamp);

    if (type === "session_meta") continue;
    if (type === "turn_context") {
      model = str(payload?.model) ?? model;
      continue;
    }
    if (type === "compacted") {
      stats.compactions++;
      messages.push({
        role: "user",
        sentAt: timestamp,
        parts: [{ type: "COMPACTION", auto: true, summary: str(payload?.message)?.slice(0, 2000) }],
        isMeta: true,
      });
      currentAssistant = undefined;
      continue;
    }
    if (type === "event_msg") {
      skip(`event_msg:${str(payload?.type) ?? "?"}`);
      continue;
    }
    if (type !== "response_item") {
      skip(type ?? "?");
      continue;
    }
    if (!payload) continue;
    const itemType = str(payload.type);

    switch (itemType) {
      case "message": {
        const role = str(payload.role);
        const text = contentText(payload.content);
        if (role === "user") {
          currentAssistant = undefined;
          messages.push({
            role: "user",
            sentAt: timestamp,
            text,
            parts: [{ type: "TEXT", text }],
            isMeta: isMetaUserText(text),
          });
        } else if (role === "assistant") {
          if (text) assistant().parts.push({ type: "TEXT", text });
          if (timestamp) assistant().sentAt ??= timestamp;
          const id = str(payload.id);
          if (id) assistant().agentMessageId ??= id;
        } else {
          // developer / system preamble
          skip(`message:${role ?? "?"}`);
        }
        break;
      }
      case "reasoning": {
        const summaryBlocks = Array.isArray(payload.summary) ? payload.summary : [];
        const text =
          summaryBlocks
            .map((b) => str(obj(b)?.text) ?? "")
            .filter(Boolean)
            .join("\n") || contentText(payload.content);
        // Encrypted reasoning with no summary yields "" — an empty part would
        // count as importable content while rendering nothing.
        if (text) assistant(timestamp).parts.push({ type: "REASONING", text });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = str(payload.name) ?? "unknown";
        const callId = str(payload.call_id) ?? str(payload.id) ?? `call-${stats.records}`;
        stats.toolNames[name] = (stats.toolNames[name] ?? 0) + 1;
        let input: unknown = payload.arguments ?? payload.input;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            /* keep raw string */
          }
        }
        const part: Extract<PortPart, { type: "TOOL" }> = {
          type: "TOOL",
          toolCallId: callId,
          toolName: name,
          kind: toolKind(name),
          state: { status: "RUNNING", input },
        };
        assistant(timestamp).parts.push(part);
        pendingByCallId.set(callId, part);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = str(payload.call_id) ?? "";
        const part = pendingByCallId.get(callId);
        if (!part) {
          stats.unmatchedToolResults++;
          break;
        }
        pendingByCallId.delete(callId);
        let output: unknown = payload.output;
        let exitCode: number | undefined;
        if (typeof output === "string") {
          try {
            const parsed = JSON.parse(output);
            if (obj(parsed)) {
              const record = parsed as Record<string, unknown>;
              const metadata = obj(record.metadata);
              // exit_code appears nested (metadata) or top-level depending on
              // the tool/version — honor either before declaring success.
              if (typeof metadata?.exit_code === "number") exitCode = metadata.exit_code;
              else if (typeof record.exit_code === "number") exitCode = record.exit_code;
              if ("output" in record) output = record.output;
            }
          } catch {
            /* raw string output */
          }
        }
        part.state =
          exitCode !== undefined && exitCode !== 0
            ? { status: "ERROR", input: part.state.input, error: String(output).slice(0, 4000) }
            : { status: "COMPLETED", input: part.state.input, output };
        break;
      }
      case "local_shell_call": {
        const action = obj(payload.action);
        const command = Array.isArray(action?.command)
          ? (action!.command as unknown[]).join(" ")
          : str(action?.command);
        const callId = str(payload.call_id) ?? str(payload.id) ?? `shell-${stats.records}`;
        stats.toolNames["local_shell"] = (stats.toolNames["local_shell"] ?? 0) + 1;
        const part: Extract<PortPart, { type: "TOOL" }> = {
          type: "TOOL",
          toolCallId: callId,
          toolName: "local_shell",
          kind: "bash",
          state:
            str(payload.status) === "failed"
              ? { status: "ERROR", input: { command }, error: "Command failed" }
              : {
                  status: str(payload.status) === "completed" ? "COMPLETED" : "RUNNING",
                  input: { command },
                },
        };
        assistant().parts.push(part);
        // Codex emits the result as function_call_output with the same call_id;
        // registering here lets the shared output handler complete it.
        pendingByCallId.set(callId, part);
        break;
      }
      case "web_search_call": {
        const action = obj(payload.action);
        const callId = str(payload.id) ?? `search-${stats.records}`;
        stats.toolNames["web_search"] = (stats.toolNames["web_search"] ?? 0) + 1;
        const status = str(payload.status);
        const input = { query: str(action?.query) };
        assistant().parts.push({
          type: "TOOL",
          toolCallId: callId,
          toolName: "web_search",
          kind: "search",
          // Same status discipline as other tools: failures stay failures,
          // unfinished searches stay RUNNING (rendered as interrupted).
          state:
            status === "failed"
              ? { status: "ERROR", input, error: "Search failed" }
              : status !== undefined && status !== "completed"
                ? { status: "RUNNING", input }
                : { status: "COMPLETED", input },
        });
        break;
      }
      default:
        skip(`response_item:${itemType ?? "?"}`);
    }
  }

  stats.orphanToolCalls = [...pendingByCallId.values()].filter(
    (p) => p.state.status === "RUNNING"
  ).length;
  stats.parseMs = performance.now() - startedAt;
  return { head, messages, stats };
}
