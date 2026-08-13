// packages/agent-ports/src/types.ts
// Canonical shapes a port produces. Mirrors shared/messages/types.ts (TEXT /
// REASONING / TOOL / COMPACTION parts, 4-state tool lifecycle) so a full-parse
// result can be inserted into deus.db sessions/messages/parts with no further
// transformation. Self-contained for the prototype; production should import
// the zod schemas from shared/messages instead.

export type PortProvider = "claude-code" | "codex" | "cursor";

/** Stable identity for dedupe + idempotent re-sync (Cursor uses the same trick). */
export interface SessionIdentity {
  provider: PortProvider;
  /** cwd the session ran in ("" when unknowable, e.g. some Cursor chats). */
  cwd: string;
  /** Provider-native session id (Claude sessionId, Codex rollout id, Cursor composerId). */
  sessionId: string;
}

export function identityKey(id: SessionIdentity): string {
  return `${id.provider}:${JSON.stringify({ cwd: id.cwd, sessionId: id.sessionId })}`;
}

/** Cheap listing row — produced by head-parse only, never a full read. */
export interface PortableSessionHead {
  identity: SessionIdentity;
  sourceFilePath: string;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  title?: string;
  firstUserPrompt?: string;
  lastTimestamp?: string;
  messageCount: number;
  /** Provider model/harness info when cheaply available. */
  model?: string;
  /** Provider-specific head fields (e.g. Codex originator/source). */
  extra?: Record<string, string>;
  /** Anything the head-parser saw but did not understand. */
  unhandledTypes: string[];
  parseErrors: HeadParseError[];
  truncatedHead: boolean;
}

export interface HeadParseError {
  lineNumber: number;
  message: string;
}

// --- Full parse output: canonical messages + parts -------------------------

export type PortToolStatus = "COMPLETED" | "ERROR" | "RUNNING";

export interface PortToolState {
  status: PortToolStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  title?: string;
}

export type PortToolKind = "read" | "write" | "bash" | "search" | "mcp" | "task" | "other";

export type PortPart =
  | {
      type: "TEXT";
      text: string;
      parentToolCallId?: string;
    }
  | {
      type: "REASONING";
      text: string;
      parentToolCallId?: string;
    }
  | {
      type: "TOOL";
      toolCallId: string;
      toolName: string;
      kind: PortToolKind;
      state: PortToolState;
      parentToolCallId?: string;
    }
  | {
      type: "COMPACTION";
      auto: boolean;
      summary?: string;
    };

export interface PortMessage {
  role: "user" | "assistant";
  /** Provider-native message id when present (→ messages.agent_message_id). */
  agentMessageId?: string;
  sentAt?: string;
  model?: string;
  /** User messages: plain text. Assistant messages: parts carry the content. */
  text?: string;
  parts: PortPart[];
  /** True when this is provider/meta chatter a UI should hide (env context, hooks…). */
  isMeta?: boolean;
}

export interface PortableSession {
  head: PortableSessionHead;
  messages: PortMessage[];
  stats: FullParseStats;
}

export interface FullParseStats {
  records: number;
  skippedRecordTypes: Record<string, number>;
  toolNames: Record<string, number>;
  unmatchedToolResults: number;
  orphanToolCalls: number;
  sidechainRecords: number;
  sidechainLinked: number;
  compactions: number;
  parseErrors: number;
  bytes: number;
  parseMs: number;
}

// --- Scanning --------------------------------------------------------------

export interface ScanOptions {
  homeDir: string;
  /** Only sessions touched within this many days (Cursor uses 30). */
  maxAgeDays?: number;
  /** Cap per provider (Cursor uses 50 per project). 0 = unlimited. */
  maxSessions?: number;
  /** Restrict to sessions whose cwd matches one of these prefixes. */
  cwdFilters?: string[];
}
