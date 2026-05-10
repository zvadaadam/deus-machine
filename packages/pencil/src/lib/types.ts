// packages/pencil/src/lib/types.ts
//
// Shared types across the AAP. Importing modules pull these instead of
// redefining shapes locally.

import type { ChildProcess } from "node:child_process";

/** Per-launch context — the workspace path the CLI runs in, and the AAP
 *  storage dir we keep designs/previews/auth-key under. */
export interface Context {
  workspace: string;
  storage: string;
}

// ---- auth -----------------------------------------------------------------

export type CliKeySource = "env" | "file";

export interface ResolvedKey {
  key: string;
  source: CliKeySource;
}

export interface AuthState {
  authed: boolean;
  cliKeySet: boolean;
  cliKeySource: CliKeySource | null;
  sessionFile: string;
  sessionExists: boolean;
  sessionValid: boolean;
  sessionEmail: string | null;
  deusCliKeyFile: string;
}

// ---- cli ------------------------------------------------------------------

export interface CliResult {
  ok: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CliErrorParse {
  code:
    | "auth_missing"
    | "auth_invalid"
    | "network"
    | "anthropic_key_missing"
    | "rate_limit"
    | "model_not_found"
    | "unknown";
  message: string;
}

export interface CliVerifyResult {
  ok: boolean;
  email?: string | null;
  error?: string;
  raw?: string;
}

// ---- ops ------------------------------------------------------------------

export type OpKind = "design" | "iterate" | "export";

export interface Op {
  id: string;
  kind: OpKind;
  name: string;
  startedAt: number;
  child: ChildProcess | null;
  pid: number | null;
  stderrTail: string;
  phase?: string;
}

// ---- designs --------------------------------------------------------------

export interface Design {
  name: string;
  file: string;
  preview: string;
  sizeBytes: number;
  modifiedAt: string;
  previewExists: boolean;
}

// ---- mcp ------------------------------------------------------------------

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  isError?: boolean;
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
}

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  run(args: TArgs, ctx: Context): Promise<ToolResult>;
}
