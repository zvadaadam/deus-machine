/**
 * App Event Catalog
 *
 * Single source of truth for ALL real-time event names and their payload schemas.
 * These events flow through the app via different transports (Electron IPC, stdout
 * relay, Unix socket) but the contracts are defined here regardless of how
 * they're delivered.
 *
 * Every `listen()` call in the frontend MUST use an event name from this file.
 * The Electron main process (apps/desktop/main/) must be kept in sync manually.
 *
 * Adding a new event:
 *   1. Add the event name constant below
 *   2. Define the Zod schema + inferred type
 *   3. Add the mapping to AppEventMap
 *   4. If emitted from main process, update the corresponding handler in apps/desktop/main/
 *   5. TypeScript will enforce correct payload types at all listen() call sites
 */

import { z } from "zod";

// ============================================================================
// Event Name Constants
// ============================================================================

/** Workspace events — backend → main process → frontend */
export const WORKSPACE_PROGRESS = "workspace:progress" as const;

/** File system events — chokidar watcher → frontend */
export const FS_CHANGED = "fs:changed" as const;

/** PTY events — node-pty manager → frontend */
export const PTY_DATA = "pty-data" as const;
export const PTY_EXIT = "pty-exit" as const;

/** Browser automation events — Electron BrowserView → frontend */
export const BROWSER_PAGE_LOAD = "browser:page-load" as const;
export const BROWSER_TITLE_CHANGED = "browser:title-changed" as const;
export const BROWSER_URL_CHANGE = "browser:url-change" as const;
export const BROWSER_WORKSPACE_CHANGE = "browser-window:workspace-change" as const;
export const BROWSER_DETACHED_CLOSED = "browser:detached-closed" as const;
export const BROWSER_NEW_TAB_REQUESTED = "browser:new-tab-requested" as const;

/** Simulator events — main process → frontend */
export const SIM_BUILD_LOG = "sim:build-log" as const;

/** Chat insert events — main process → frontend */
export const CHAT_INSERT = "chat-insert" as const;

/** Backend lifecycle — main process → frontend */
export const BACKEND_PORT_CHANGED = "backend:port-changed" as const;

/** Git operations — main process → frontend */
export const GIT_CLONE_PROGRESS = "git-clone-progress" as const;

// ============================================================================
// Domain Constants (queryable resources, mutations, agent-server notifications)
// ============================================================================

/** Queryable resources — subscribable via q:subscribe for real-time push.
 *  Derive the type from the const array so runtime validators and
 *  compile-time checks always stay in sync. */
export const QUERY_RESOURCES = ["workspaces", "stats", "sessions", "session", "messages"] as const;
export type QueryResource = (typeof QUERY_RESOURCES)[number];

/** Request-only resources — one-shot reads via q:request, not subscribable.
 *  These delegate to existing Hono routes under the hood. */
export const REQUEST_RESOURCES = [
  "settings",
  "repos",
  "repoManifest",
  "detectManifest",
  "agentConfig",
  "ghStatus",
  "prStatus",
  "workspace",
  "allWorkspaces",
  "workspaceManifest",
  "setupLogs",
  "diffStats",
  "diffFiles",
  "diffFile",
  "penFiles",
  "workspaceFiles",
  "fileContent",
  "fileSearch",
  "recentProjects",
  "pairedDevices",
  "relayStatus",
  "allSessions",
  "repoPrs",
  "repoBranches",
  "agentAuth",
] as const;
export type RequestResource = QueryResource | (typeof REQUEST_RESOURCES)[number];

/** Mutation action names for the WebSocket relay protocol (sync data writes). */
export const MUTATION_NAMES = [
  "archiveWorkspace",
  "updateWorkspaceTitle",
  "updateWorkspaceStatus",
  // New mutations
  "updateWorkspace",
  "createSession",
  "addRepo",
  "saveRepoManifest",
  "saveAgentConfig",
  "deleteAgentConfig",
  "saveSetting",
  "invalidateFileCache",
  "runTask",
  "revokeDevice",
] as const;
export type MutationName = (typeof MUTATION_NAMES)[number];

/** Command names for the WebSocket relay protocol (async actions). */
export const COMMAND_NAMES = [
  "sendMessage",
  "stopSession",
  // PTY commands
  "pty:spawn",
  "pty:write",
  "pty:resize",
  "pty:kill",
  // File system commands
  "fs:watch",
  "fs:unwatch",
  // Git commands
  "git:clone",
  "git:init",
  // New commands
  "createWorkspace",
  "retrySetup",
  "openPenFile",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Protocol events — ephemeral notifications pushed to all connected clients. */
export const PROTOCOL_EVENTS = [
  "session:plan-mode",
  "session:error",
  "session:progress",
  "tool:request",
  // PTY events (high-throughput)
  "pty-data",
  "pty-exit",
  // File system events
  "fs:changed",
  // Git events
  "git-clone-progress",
  "git-init-progress",
  // Agent-server bidirectional RPC
  "agent-server:request",
] as const;
export type ProtocolEvent = (typeof PROTOCOL_EVENTS)[number];

// ============================================================================
// Payload Schemas
// ============================================================================

export const WorkspaceProgressSchema = z.object({
  workspaceId: z.string(),
  step: z.string(),
  label: z.string(),
});
export type WorkspaceProgressEvent = z.infer<typeof WorkspaceProgressSchema>;

export const FileChangeSchema = z.object({
  workspace_path: z.string(),
  change_type: z.enum(["add", "change", "unlink", "mixed", "metadataonly"]),
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
  error: z.object({ code: z.number(), description: z.string() }).optional(),
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

export const BrowserNewTabRequestedSchema = z.object({
  url: z.string(),
  disposition: z.string().optional(),
  openerLabel: z.string().optional(),
});
export type BrowserNewTabRequestedEvent = z.infer<typeof BrowserNewTabRequestedSchema>;

export const SimBuildLogSchema = z.object({
  workspaceId: z.string(),
  line: z.string(),
});
export type SimBuildLogEvent = z.infer<typeof SimBuildLogSchema>;

export const BackendPortChangedSchema = z.object({
  port: z.number(),
});
export type BackendPortChangedEvent = z.infer<typeof BackendPortChangedSchema>;

export const GitCloneProgressSchema = z.object({
  /** Raw stderr line from git clone --progress */
  line: z.string(),
});
export type GitCloneProgressEvent = z.infer<typeof GitCloneProgressSchema>;

/** InspectElement schema — matches the shape emitted by the browser InSpec handler.
 *  Keep in sync with InspectElement in parseInspectTags.ts. */
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

/** Serialized chat insert payload (main process → frontend).
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
 * the IPC boundary — catches payload drift at runtime.
 */
export const AppEventSchemaMap = {
  [BACKEND_PORT_CHANGED]: BackendPortChangedSchema,
  [WORKSPACE_PROGRESS]: WorkspaceProgressSchema,
  [FS_CHANGED]: FileChangeSchema,
  [PTY_DATA]: PtyDataSchema,
  [PTY_EXIT]: PtyExitSchema,
  [BROWSER_PAGE_LOAD]: BrowserPageLoadSchema,
  [BROWSER_TITLE_CHANGED]: BrowserTitleChangedSchema,
  [BROWSER_URL_CHANGE]: BrowserUrlChangeSchema,
  [BROWSER_WORKSPACE_CHANGE]: BrowserWorkspaceChangeSchema,
  [BROWSER_DETACHED_CLOSED]: z.undefined(),
  [BROWSER_NEW_TAB_REQUESTED]: BrowserNewTabRequestedSchema,
  [SIM_BUILD_LOG]: SimBuildLogSchema,
  [CHAT_INSERT]: ChatInsertSchema,
  [GIT_CLONE_PROGRESS]: GitCloneProgressSchema,
} as const satisfies Record<AppEventName, z.ZodTypeAny>;

// ============================================================================
// Type-Safe Event Map
// ============================================================================

/**
 * Maps every app event name to its payload type.
 * Used by the typed `listen()` wrapper in platform/electron to provide
 * autocomplete on event names and auto-inferred payload types.
 */
export interface AppEventMap {
  // Backend lifecycle
  [BACKEND_PORT_CHANGED]: BackendPortChangedEvent;

  // Workspace
  [WORKSPACE_PROGRESS]: WorkspaceProgressEvent;

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
  [BROWSER_DETACHED_CLOSED]: undefined;
  [BROWSER_NEW_TAB_REQUESTED]: BrowserNewTabRequestedEvent;

  // Simulator
  [SIM_BUILD_LOG]: SimBuildLogEvent;

  // Chat
  [CHAT_INSERT]: SerializedChatInsertPayload;

  // Git
  [GIT_CLONE_PROGRESS]: GitCloneProgressEvent;
}

/** Union of all known app event names */
export type AppEventName = keyof AppEventMap;
