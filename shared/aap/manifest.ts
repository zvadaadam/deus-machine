// shared/aap/manifest.ts
// Zod schema + types for agentic-app.json manifests (AAP v1).
//
// Protocol spec: docs/aap-v1-design.html
// Host design:   docs/aap-host-design.md
//
// The schema is intentionally tight: it only accepts what Phase 1-4 consumes.
// Fields proposed for v2 (commands, events, capabilities, extra tool
// transports, extra requires types) are not declared here. Zod strips unknown
// keys by default, so manifests that ship those fields still parse cleanly —
// they just don't appear on the parsed object until the schema grows.

import { z } from "zod";

// ----------------------------------------------------------------------------
// Small field schemas
// ----------------------------------------------------------------------------

/** Reverse-DNS-ish identifier. Lowercase letters, digits, `.` and `-` only.
 *  Must start with a letter. Drives the MCP server name after normalization. */
export const AppIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[.\-][a-z0-9]+)+$/, {
    message: "id must be reverse-DNS: lowercase letters, digits, `.` or `-` (e.g. deus.mobile-use)",
  });
export type AppId = z.infer<typeof AppIdSchema>;

const ReadyProbeHttpSchema = z.object({
  type: z.literal("http"),
  path: z.string().min(1),
  timeoutMs: z.number().int().positive().default(30_000),
});

const ReadyProbeTcpSchema = z.object({
  type: z.literal("tcp"),
  timeoutMs: z.number().int().positive().default(30_000),
});

export const ReadyProbeSchema = z.discriminatedUnion("type", [
  ReadyProbeHttpSchema,
  ReadyProbeTcpSchema,
]);
export type ReadyProbe = z.infer<typeof ReadyProbeSchema>;

// ----------------------------------------------------------------------------
// launch
// ----------------------------------------------------------------------------

export const LaunchSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  ready: ReadyProbeSchema.default({ type: "tcp", timeoutMs: 30_000 }),
});
export type Launch = z.infer<typeof LaunchSchema>;

// ----------------------------------------------------------------------------
// ui — just a URL in v1
// ----------------------------------------------------------------------------

export const UiSchema = z.object({
  url: z.string().min(1),
});
export type Ui = z.infer<typeof UiSchema>;

// ----------------------------------------------------------------------------
// agent — mcp-http only in v1
// ----------------------------------------------------------------------------

export const AgentToolsSchema = z.object({
  type: z.literal("mcp-http"),
  url: z.string().min(1),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;

export const AgentSchema = z.object({
  tools: AgentToolsSchema,
  bootstrap: z.string().optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

// ----------------------------------------------------------------------------
// storage
// ----------------------------------------------------------------------------

export const StorageSchema = z
  .object({
    workspace: z.string().optional(),
    global: z.string().optional(),
  })
  .default({});
export type Storage = z.infer<typeof StorageSchema>;

// ----------------------------------------------------------------------------
// lifecycle — scope + stopTimeoutMs. SIGTERM is implicit; dedupe is hardcoded.
// ----------------------------------------------------------------------------

export const LifecycleScopeSchema = z.enum(["workspace", "session", "global"]);
export type LifecycleScope = z.infer<typeof LifecycleScopeSchema>;

export const LifecycleSchema = z
  .object({
    scope: LifecycleScopeSchema.default("workspace"),
    stopTimeoutMs: z.number().int().positive().default(5_000),
  })
  .default({ scope: "workspace", stopTimeoutMs: 5_000 });
export type Lifecycle = z.infer<typeof LifecycleSchema>;

// ----------------------------------------------------------------------------
// requires — prerequisite validation (cli + platform only in v1)
// ----------------------------------------------------------------------------

const RequireCliSchema = z.object({
  type: z.literal("cli"),
  name: z.string().min(1),
  install: z.string().optional(),
});
const RequirePlatformSchema = z.object({
  type: z.literal("platform"),
  os: z.enum(["darwin", "linux", "win32"]).optional(),
  arch: z.enum(["arm64", "x64"]).optional(),
});

export const RequirementSchema = z.discriminatedUnion("type", [
  RequireCliSchema,
  RequirePlatformSchema,
]);
export type Requirement = z.infer<typeof RequirementSchema>;

// ----------------------------------------------------------------------------
// top-level manifest
// ----------------------------------------------------------------------------

export const ManifestSchema = z.object({
  $schema: z.string().optional(),
  // v1 host only understands v1 manifests. A future v2 must bump this and the
  // host schema in lockstep; a v2 manifest against a v1 host will fail loudly
  // here rather than being silently stripped of v2-only fields.
  protocolVersion: z.literal("1"),

  id: AppIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  icon: z.string().optional(),

  launch: LaunchSchema,
  ui: UiSchema,
  agent: AgentSchema,
  storage: StorageSchema,
  lifecycle: LifecycleSchema,
  requires: z.array(RequirementSchema).default([]),

  /** Optional list of skill files (relative to the package root) the host
   *  exposes via `aap/read-app-skill`. Read on demand, never inlined into
   *  the `launch_app` tool result — keeps the happy-path lean. The tool
   *  concatenates every entry in order, with `# <path>` dividers. */
  skills: z.array(z.string().min(1)).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Convert an AAP `id` to a valid MCP server name.
 *
 *  Rule (from the spec): replace `.` and `-` with `_`. The SDK then namespaces
 *  every tool as `mcp__{serverName}__{toolName}` — Claude's tool-name limit is
 *  64 chars, so the server name must leave room for tool names.
 *
 *  Example: `deus.mobile-use` → `deus_mobile_use`
 */
export function idToServerName(id: AppId): string {
  return id.replace(/[.\-]/g, "_");
}

/** Parse + validate a manifest object. Throws a ZodError on failure. */
export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

/** Non-throwing variant. Returns `{ success, data | error }`. */
export function safeParseManifest(input: unknown) {
  return ManifestSchema.safeParse(input);
}
