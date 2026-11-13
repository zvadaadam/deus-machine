/**
 * Two things live here.
 *
 * The desktop's events: what the Electron main process sends the renderer
 * (`native.events.on`), each with its name, schema and payload type. Every
 * `listen()` call in the frontend uses a name from this file, and the main
 * process (apps/desktop/main/) is kept in sync by hand.
 *
 * The cloud payloads: what a cloud workspace's sandbox, device and preview
 * report, as the host passes them on. What a HOST sends a client is not named
 * here: those are the streams declared in `shared/api`.
 */

import { z } from "zod";

// ============================================================================
// Event Name Constants
// ============================================================================

/** Workspace events — backend → main process → frontend */
export const WORKSPACE_PROGRESS = "workspace:progress" as const;

/** Browser guest-page popup requests — main process → renderer.
 *  Fired when a <webview>'s guest page calls window.open() or navigates a
 *  `target="_blank"` link. The main renderer opens a new browser tab so the
 *  flow (OAuth redirects, etc.) stays in-app. */
export const BROWSER_NEW_TAB_REQUESTED = "browser:new-tab-requested" as const;

/** Backend lifecycle — main process → frontend */
export const BACKEND_PORT_CHANGED = "backend:port-changed" as const;

// ============================================================================
// Payload Schemas
// ============================================================================

export const WorkspaceProgressSchema = z.object({
  workspaceId: z.string(),
  step: z.string(),
  label: z.string(),
});
export type WorkspaceProgressEvent = z.infer<typeof WorkspaceProgressSchema>;

/**
 * Cloud sandbox state, as passed through from the platform's workspace.state
 * events (the `cloudEnvironment` stream). Deliberately lenient — `status` is an open string and
 * unknown fields pass through — so a newer platform can add statuses without
 * breaking older clients; the UI treats unknown statuses as in-flight.
 */
export const CloudEnvStateSchema = z
  .object({
    /** provisioning | running | paused | stopped | error (open set) */
    status: z.string(),
    /** Provisioning step label (e.g. "cloning_repository"). */
    step: z.string().optional(),
    /** Pause/stop/error detail, when the platform sends one. */
    reason: z.string().optional(),
    /** Error detail (status "error" only). */
    errorMessage: z.string().optional(),
    /** running only: the sandbox came back with session state restored. */
    snapshotRestored: z.boolean().optional(),
    /** running only: the sandbox's public host template (`{{port}}` placeholder). */
    sandboxUrlTemplate: z.string().nullable().optional(),
  })
  .loose();
export type CloudEnvState = z.infer<typeof CloudEnvStateSchema>;

export interface CloudEnvEvent {
  workspaceId: string;
  sessionId: string;
  data: CloudEnvState;
}

/** The computer's host template for a workspace — a capability URL template
 *  (`https://{{port}}-<sandbox>.e2b.app`) that changes with every reprovision;
 *  null = the platform reports no sandbox. */
export interface CloudPreviewEvent {
  workspaceId: string;
  sessionId: string;
  template: string | null;
}

/** The backend's identity generation after the account it acts for changed. */
export interface CloudIdentityEvent {
  generation: number;
}

/**
 * Hosted simulator events (`cloudSimulatorEvents`): the platform's simulator.*
 * frames passed through minus their `type`. Same tolerance policy as
 * CloudEnvStateSchema — `status` is an open string and unknown fields pass
 * through, because the platform deploys continuously while desktop builds
 * don't; the UI treats an unknown status as in-flight. `platform` stays a
 * closed enum: the device frame keys off it, and a new
 * platform is a pin bump on both sides, not a silent addition. (The row
 * holds none of this — see the note above.)
 *
 * `data` is the platform payload verbatim: its `sessionId` (when present) is
 * the agnt session id; the top-level `sessionId` is the deus session the
 * frame arrived on. The device belongs to the WORKSPACE — agnt fans its status
 * out to every session — so consumers key on `workspaceId`.
 */
export const CloudSimulatorPlatformSchema = z.enum(["ios", "android"]);
export type CloudSimulatorPlatform = z.infer<typeof CloudSimulatorPlatformSchema>;

export const CloudSimulatorStatusSchema = z
  .object({
    /** starting | ready | stopping | stopped | error (open set) */
    status: z.string(),
    /** Absent only on a backend-synthesized error (no sidecar to name a device). */
    platform: CloudSimulatorPlatformSchema.optional(),
    easSessionIdentifier: z.string().optional(),
    /** Live stream URL — a capability URL; never rides a stopped status. */
    streamUrl: z.string().optional(),
    /** Platform error text (status "error" only). */
    error: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .loose();
export type CloudSimulatorStatus = z.infer<typeof CloudSimulatorStatusSchema>;

export const CloudSimulatorScreenshotSchema = z
  .object({
    platform: CloudSimulatorPlatformSchema.optional(),
    imageBase64: z.string(),
    /** "png" today. */
    format: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .loose();
export type CloudSimulatorScreenshot = z.infer<typeof CloudSimulatorScreenshotSchema>;

export const CloudSimulatorActionResultSchema = z
  .object({
    platform: CloudSimulatorPlatformSchema.optional(),
    /** Device verb (press, fill, scroll, screenshot, …). */
    verb: z.string(),
    args: z.array(z.string()).optional(),
    success: z.boolean(),
    /** Output excerpt (the platform caps it at 2000 chars). */
    output: z.string().optional(),
    error: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .loose();
export type CloudSimulatorActionResult = z.infer<typeof CloudSimulatorActionResultSchema>;

const cloudSimulatorEnvelope = { workspaceId: z.string(), sessionId: z.string() };
export const CloudSimulatorEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...cloudSimulatorEnvelope,
    kind: z.literal("status"),
    data: CloudSimulatorStatusSchema,
  }),
  z.object({
    ...cloudSimulatorEnvelope,
    kind: z.literal("screenshot"),
    data: CloudSimulatorScreenshotSchema,
  }),
  z.object({
    ...cloudSimulatorEnvelope,
    kind: z.literal("action_result"),
    data: CloudSimulatorActionResultSchema,
  }),
  // Backend-synthesized: the platform's REST read reported no device for the
  // workspace, so every client drops what it held (a device that no longer
  // exists). No platform frame says this — a socket only ever carries a
  // status — hence a kind of its own.
  z.object({
    ...cloudSimulatorEnvelope,
    kind: z.literal("gone"),
    data: z.object({}),
  }),
]);
export type CloudSimulatorEvent = z.infer<typeof CloudSimulatorEventSchema>;
export type CloudSimulatorEventKind = CloudSimulatorEvent["kind"];

const BrowserNewTabRequestedSchema = z.object({
  url: z.string(),
  disposition: z.string().optional(),
  /** The guest webContents that asked — the event is window-wide, and only
   *  the panel owning that webview may act on it. */
  sourceWebContentsId: z.number().optional(),
});
type BrowserNewTabRequestedEvent = z.infer<typeof BrowserNewTabRequestedSchema>;

const BackendPortChangedSchema = z.object({
  port: z.number(),
});
type BackendPortChangedEvent = z.infer<typeof BackendPortChangedSchema>;

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
  [BROWSER_NEW_TAB_REQUESTED]: BrowserNewTabRequestedSchema,
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

  // Browser
  [BROWSER_NEW_TAB_REQUESTED]: BrowserNewTabRequestedEvent;
}

/** Union of all known app event names */
export type AppEventName = keyof AppEventMap;
