/**
 * App Event Catalog
 *
 * Single source of truth for ALL real-time event names and their payload schemas.
 * These events flow through the app via different transports (Tauri IPC, stdout
 * relay, Unix socket) but the contracts are defined here regardless of how
 * they're delivered.
 *
 * Every `listen()` call in the frontend MUST use an event name from this file.
 * The Rust layer (socket.rs, backend.rs) must be kept in sync manually — see
 * the `SYNC:` comments in those files pointing back here.
 *
 * Adding a new event:
 *   1. Add the event name constant below
 *   2. Define the Zod schema + inferred type
 *   3. Add the mapping to AppEventMap
 *   4. If emitted from Rust, update the corresponding .rs file
 *   5. TypeScript will enforce correct payload types at all listen() call sites
 */

import { z } from "zod";

// ============================================================================
// Event Name Constants
// ============================================================================

/** Workspace events — backend → Rust → frontend */
export const WORKSPACE_PROGRESS = "workspace:progress" as const;

/** Sidecar RPC — sidecar → Rust → frontend (bidirectional requests) */
export const SIDECAR_REQUEST = "sidecar:request" as const;

/** File system events — Rust watcher → frontend */
export const FS_CHANGED = "fs:changed" as const;

/** PTY events — Rust PTY manager → frontend */
export const PTY_DATA = "pty-data" as const;
export const PTY_EXIT = "pty-exit" as const;

/** Browser automation events — Rust webview → frontend */
export const BROWSER_PAGE_LOAD = "browser:page-load" as const;
export const BROWSER_TITLE_CHANGED = "browser:title-changed" as const;
export const BROWSER_URL_CHANGE = "browser:url-change" as const;
export const BROWSER_WORKSPACE_CHANGE = "browser-window:workspace-change" as const;

/** Simulator events — Rust → frontend */
export const SIM_BUILD_LOG = "sim:build-log" as const;

/** Chat insert events — Rust → frontend */
export const CHAT_INSERT = "chat-insert" as const;

/** Git operations — Rust → frontend */
export const GIT_CLONE_PROGRESS = "git-clone-progress" as const;

// ============================================================================
// Domain Constants (queryable resources, mutations, sidecar notifications)
// ============================================================================

/** Queryable resources — single source of truth.
 *  Derive the type from the const array so runtime validators and
 *  compile-time checks always stay in sync. */
export const QUERY_RESOURCES = ["workspaces", "stats", "sessions", "session", "messages"] as const;
export type QueryResource = (typeof QUERY_RESOURCES)[number];

/** Mutation action names for the WebSocket relay protocol (sync data writes). */
export const MUTATION_NAMES = ["archiveWorkspace", "updateWorkspaceTitle"] as const;
export type MutationName = (typeof MUTATION_NAMES)[number];

/** Command names for the WebSocket relay protocol (async actions). */
export const COMMAND_NAMES = ["sendMessage", "stopSession"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Protocol events — ephemeral notifications pushed to all connected clients. */
export const PROTOCOL_EVENTS = ["session:plan-mode", "session:error", "session:progress", "tool:request"] as const;
export type ProtocolEvent = (typeof PROTOCOL_EVENTS)[number];

/** Event names the sidecar sends to POST /notify on the backend.
 *  Must match the strings passed to notifyBackend() in sidecar/db/session-writer.ts. */
export const NOTIFY_SESSION_MESSAGE = "session:message" as const;
export const NOTIFY_SESSION_STATUS = "session:status" as const;
export const NOTIFY_SESSION_UPDATED = "session:updated" as const;
export const SIDECAR_NOTIFY_EVENTS = [
  NOTIFY_SESSION_MESSAGE,
  NOTIFY_SESSION_STATUS,
  NOTIFY_SESSION_UPDATED,
] as const;
export type SidecarNotifyEvent = (typeof SIDECAR_NOTIFY_EVENTS)[number];

// ============================================================================
// Payload Schemas
// ============================================================================

export const WorkspaceProgressSchema = z.object({
  workspaceId: z.string(),
  step: z.string(),
  label: z.string(),
});
export type WorkspaceProgressEvent = z.infer<typeof WorkspaceProgressSchema>;

export const SidecarRpcRequestSchema = z.object({
  id: z.unknown(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type SidecarRpcRequest = z.infer<typeof SidecarRpcRequestSchema>;

export const FileChangeSchema = z.object({
  workspace_path: z.string(),
  change_type: z.enum(["fileschanged", "metadataonly"]),
  affected_count: z.number(),
});
export type FileChangeEvent = z.infer<typeof FileChangeSchema>;

export const PtyDataSchema = z.object({
  id: z.string(),
  data: z.array(z.number()),
});
export type PtyDataEvent = z.infer<typeof PtyDataSchema>;

export const PtyExitSchema = z.object({
  id: z.string(),
});
export type PtyExitEvent = z.infer<typeof PtyExitSchema>;

export const BrowserPageLoadSchema = z.object({
  label: z.string(),
  url: z.string(),
  event: z.string(),
});
export type BrowserPageLoadEvent = z.infer<typeof BrowserPageLoadSchema>;

export const BrowserTitleChangedSchema = z.object({
  label: z.string(),
  title: z.string(),
});
export type BrowserTitleChangedEvent = z.infer<typeof BrowserTitleChangedSchema>;

export const BrowserUrlChangeSchema = z.object({
  label: z.string(),
  url: z.string(),
});
export type BrowserUrlChangeEvent = z.infer<typeof BrowserUrlChangeSchema>;

export const BrowserWorkspaceChangeSchema = z.object({
  workspaceId: z.string(),
  directoryName: z.string().nullish(),
  repoName: z.string().nullish(),
  branch: z.string().nullish(),
});
export type BrowserWorkspaceChangeEvent = z.infer<typeof BrowserWorkspaceChangeSchema>;

export const SimBuildLogSchema = z.object({
  workspaceId: z.string(),
  line: z.string(),
});
export type SimBuildLogEvent = z.infer<typeof SimBuildLogSchema>;

export const GitCloneProgressSchema = z.object({
  percent: z.number(),
  received: z.number(),
  total: z.number(),
  received_bytes: z.number(),
  status: z.string(),
  phase: z.enum(["connecting", "receiving", "indexing", "resolving", "complete"]),
});
export type GitCloneProgressEvent = z.infer<typeof GitCloneProgressSchema>;

/** InspectElement schema — matches the shape emitted by the browser InSpec handler
 *  through Rust. Keep in sync with InspectElement in parseInspectTags.ts. */
const InspectElementSchema = z.object({
  ref: z.string(),
  tagName: z.string(),
  path: z.string(),
  innerText: z.string().optional(),
  context: z.enum(["local", "external"]).optional(),
  reactComponent: z.string().optional(),
  file: z.string().optional(),
  line: z.string().optional(),
  styles: z.string().optional(),
  props: z.string().optional(),
  attributes: z.string().optional(),
  innerHTML: z.string().optional(),
});

/** Serialized chat insert payload (Rust → frontend).
 *  Keep in sync with SerializedChatInsertPayload in chatInsertStore.ts. */
export const ChatInsertSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    workspaceId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("element"),
    workspaceId: z.string(),
    element: InspectElementSchema,
  }),
  z.object({
    type: z.literal("files"),
    workspaceId: z.string(),
    files: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        lastModified: z.number(),
        base64: z.string(),
      })
    ),
  }),
]);
export type SerializedChatInsertPayload = z.infer<typeof ChatInsertSchema>;

// ============================================================================
// Runtime Schema Map (event name → Zod schema)
// ============================================================================

/**
 * Maps every known event name to its Zod schema for runtime validation.
 * Used by the typed `listen()` wrapper to validate payloads crossing
 * the Rust → TypeScript boundary — catches payload drift at runtime.
 */
export const AppEventSchemaMap = {
  [WORKSPACE_PROGRESS]: WorkspaceProgressSchema,
  [SIDECAR_REQUEST]: SidecarRpcRequestSchema,
  [FS_CHANGED]: FileChangeSchema,
  [PTY_DATA]: PtyDataSchema,
  [PTY_EXIT]: PtyExitSchema,
  [BROWSER_PAGE_LOAD]: BrowserPageLoadSchema,
  [BROWSER_TITLE_CHANGED]: BrowserTitleChangedSchema,
  [BROWSER_URL_CHANGE]: BrowserUrlChangeSchema,
  [BROWSER_WORKSPACE_CHANGE]: BrowserWorkspaceChangeSchema,
  [SIM_BUILD_LOG]: SimBuildLogSchema,
  [CHAT_INSERT]: ChatInsertSchema,
  [GIT_CLONE_PROGRESS]: GitCloneProgressSchema,
} as const satisfies Record<AppEventName, z.ZodTypeAny>;

// ============================================================================
// Type-Safe Event Map
// ============================================================================

/**
 * Maps every app event name to its payload type.
 * Used by the typed `listen()` wrapper in platform/tauri to provide
 * autocomplete on event names and auto-inferred payload types.
 */
export interface AppEventMap {
  // Workspace
  [WORKSPACE_PROGRESS]: WorkspaceProgressEvent;

  // Sidecar RPC
  [SIDECAR_REQUEST]: SidecarRpcRequest;

  // File system
  [FS_CHANGED]: FileChangeEvent;

  // PTY
  [PTY_DATA]: PtyDataEvent;
  [PTY_EXIT]: PtyExitEvent;

  // Browser
  [BROWSER_PAGE_LOAD]: BrowserPageLoadEvent;
  [BROWSER_TITLE_CHANGED]: BrowserTitleChangedEvent;
  [BROWSER_URL_CHANGE]: BrowserUrlChangeEvent;
  [BROWSER_WORKSPACE_CHANGE]: BrowserWorkspaceChangeEvent;

  // Simulator
  [SIM_BUILD_LOG]: SimBuildLogEvent;

  // Chat
  [CHAT_INSERT]: SerializedChatInsertPayload;

  // Git
  [GIT_CLONE_PROGRESS]: GitCloneProgressEvent;
}

/** Union of all known app event names */
export type AppEventName = keyof AppEventMap;
