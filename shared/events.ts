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

/** Browser guest-page popup requests — main process → renderer.
 *  Fired when a <webview>'s guest page calls window.open() or navigates a
 *  `target="_blank"` link. The main renderer opens a new browser tab so the
 *  flow (OAuth redirects, etc.) stays in-app. */
export const BROWSER_NEW_TAB_REQUESTED = "browser:new-tab-requested" as const;

// Simulator build logs now use q:event "sim:buildLog" via WebSocket protocol.

/** Chat insert events — main process → frontend */
export const CHAT_INSERT = "chat-insert" as const;

/** Backend lifecycle — main process → frontend */
export const BACKEND_PORT_CHANGED = "backend:port-changed" as const;

/** Git operations — main process → frontend */
export const GIT_CLONE_PROGRESS = "git-clone-progress" as const;
export const GIT_INIT_PROGRESS = "git-init-progress" as const;

// ============================================================================
// Domain Constants (queryable resources, mutations, agent-server notifications)
// ============================================================================

/** Queryable resources — subscribable via q:subscribe for real-time push.
 *  Derive the type from the const array so runtime validators and
 *  compile-time checks always stay in sync. */
export const QUERY_RESOURCES = [
  "workspaces",
  "stats",
  "sessions",
  "session",
  "messages",
  // AAP (agentic apps protocol)
  "apps",
  "running_apps",
] as const;
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
  // Simulator commands
  "sim:listDevices",
  "sim:start",
  "sim:stop",
  "sim:touch",
  "sim:key",
  "sim:scroll",
  "sim:button",
  "sim:screenshot",
  "sim:inspectStart",
  "sim:inspectSnapshot",
  "sim:buildAndRun",
  "sim:hasXcodeProject",
  "sim:launchApp",
  "sim:terminateApp",
  "sim:uninstallApp",
  // AAP (agentic apps protocol) — user-initiated launch/stop from the Apps tab.
  // Agent-initiated launches flow through the agent-server RPC path in Phase 3
  // (not these commands), but both paths converge on apps.service.launchApp.
  "launchApp",
  "stopApp",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Protocol events — ephemeral notifications pushed to all connected clients. */
export const PROTOCOL_EVENTS = [
  "session:plan-mode",
  "session:error",
  "session:progress",
  "tool:request",
  // Message lifecycle events
  "message:created",
  "message:done",
  // Part lifecycle events (streaming, high-throughput)
  "part:created",
  "part:delta",
  "part:done",
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
  // Simulator events
  "sim:streamReady",
  "sim:stopped",
  "sim:buildLog",
  "sim:buildComplete",
  "sim:buildFailed",
  "sim:streamFailed",
  // AAP (agentic apps protocol) lifecycle — one-shot side effects around the
  // Browser tab that mirrors an app's UI.
  // Payload for both: { appId, workspaceId, runningAppId, url }.
  //   apps:launched — new tab opens to the url
  //   apps:stopped  — tabs pointing at the url are closed (the port is dead)
  "apps:launched",
  "apps:stopped",
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

const BrowserNewTabRequestedSchema = z.object({
  url: z.string(),
  disposition: z.string().optional(),
});
type BrowserNewTabRequestedEvent = z.infer<typeof BrowserNewTabRequestedSchema>;

const BackendPortChangedSchema = z.object({
  port: z.number(),
});
type BackendPortChangedEvent = z.infer<typeof BackendPortChangedSchema>;

export const GitCloneProgressSchema = z.object({
  /** Raw stderr line from git clone --progress */
  line: z.string(),
});
export type GitCloneProgressEvent = z.infer<typeof GitCloneProgressSchema>;

export const GitInitProgressSchema = z.object({
  /** Progress line from git init / gh repo create */
  line: z.string(),
});
export type GitInitProgressEvent = z.infer<typeof GitInitProgressSchema>;

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
  [BROWSER_NEW_TAB_REQUESTED]: BrowserNewTabRequestedSchema,
  [CHAT_INSERT]: ChatInsertSchema,
  [GIT_CLONE_PROGRESS]: GitCloneProgressSchema,
  [GIT_INIT_PROGRESS]: GitInitProgressSchema,
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
  [BROWSER_NEW_TAB_REQUESTED]: BrowserNewTabRequestedEvent;

  // Chat
  [CHAT_INSERT]: SerializedChatInsertPayload;

  // Git
  [GIT_CLONE_PROGRESS]: GitCloneProgressEvent;
  [GIT_INIT_PROGRESS]: GitInitProgressEvent;
}

/** Union of all known app event names */
export type AppEventName = keyof AppEventMap;
