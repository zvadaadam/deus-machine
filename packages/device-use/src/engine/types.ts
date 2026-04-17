import type { z } from "zod";

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

export type CommandExecutor = (command: string[], opts?: ExecOptions) => Promise<ExecResult>;

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export interface CommandDefinition<TParams = unknown> {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  examples?: string[];
  schema: z.ZodType<TParams>;
  handler: (params: TParams, ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  executor: CommandExecutor;
  flags: GlobalFlags;
}

export interface GlobalFlags {
  json: boolean;
  verbose: boolean;
  simulator?: string;
  noColor: boolean;
  timeoutMs?: number;
}

export interface CommandResult {
  success: boolean;
  data?: unknown;
  message?: string;
  nextSteps?: NextStep[];
  warnings?: string[];
}

export interface NextStep {
  command: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Accessibility tree
// ---------------------------------------------------------------------------

export interface AccessibilityNode {
  role: string;
  type: string;
  label?: string;
  identifier?: string;
  value?: string;
  frame: Frame;
  center: Point;
  enabled: boolean;
  focused?: boolean;
  traits: string[];
  children: AccessibilityNode[];
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Ref system
// ---------------------------------------------------------------------------

/** A single interactive element in the flat ref list. Persisted across commands. */
export interface RefEntry {
  ref: string;
  type: string;
  label?: string;
  identifier?: string;
  frame: Frame;
  center: Point;
  value?: string;
  enabled: boolean;
  traits: string[];
}

// ---------------------------------------------------------------------------
// Structured snapshot
// ---------------------------------------------------------------------------

/**
 * A node in the pruned accessibility tree returned by `snapshot`.
 * Only interactive nodes get a `ref`. Non-interactive nodes are kept for
 * structural context (containers, headings, static text near inputs).
 */
export interface SnapshotNode {
  type: string;
  ref?: string;
  label?: string;
  identifier?: string;
  value?: string;
  frame: Frame;
  center: Point;
  enabled?: boolean;
  /** True when this node was assigned a ref (i.e. tappable). */
  interactive?: boolean;
  traits?: string[];
  children?: SnapshotNode[];
}

export interface SnapshotCounts {
  total: number;
  interactive: number;
}

/** Full snapshot payload: tree for structural reading + flat refs for session state. */
export interface Snapshot {
  tree: SnapshotNode[];
  refs: RefEntry[];
  counts: SnapshotCounts;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export interface Simulator {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | "Creating" | string;
  runtime: string;
  runtimeVersion: string;
  isAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export type AppType = "User" | "System";

export interface AppInfo {
  bundleId: string;
  name: string;
  version?: string;
  type: AppType;
  bundlePath?: string;
}

export interface AppState {
  bundleId: string;
  installed: boolean;
  running: boolean;
  pid?: number;
}

// ---------------------------------------------------------------------------
// Privacy / permissions
// ---------------------------------------------------------------------------

/** Services supported by `simctl privacy`. */
export type PermissionService =
  | "all"
  | "calendar"
  | "contacts-limited"
  | "contacts"
  | "location"
  | "location-always"
  | "photos-add"
  | "photos"
  | "media-library"
  | "microphone"
  | "motion"
  | "reminders"
  | "siri";

export type PermissionAction = "grant" | "revoke" | "reset";

// ---------------------------------------------------------------------------
// simbridge protocol
// ---------------------------------------------------------------------------

export interface SimBridgeRequest {
  command: string;
  udid?: string;
  [key: string]: unknown;
}

export interface SimBridgeResponse {
  success: boolean;
  command: string;
  data?: unknown;
  error?: { code: string; message: string; details?: string };
  timing?: { durationMs: number };
}
