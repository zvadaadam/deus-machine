// shared/protocol.ts
// Turn-configuration vocabulary. These are the @zvada/agent-server values
// verbatim — snake_case permission modes, lowercase thinking levels. Deus
// used to keep camelCase/UPPERCASE spellings and translate at the backend
// edge; that dialect is gone, so a composer value travels unchanged from the
// picker to the engine's RunConfig.
//
// The `read*` helpers below absorb values persisted by older builds (settings
// rows, in-flight q:command payloads) — read-time normalization, no migration.

import { z } from "zod";
import {
  PermissionModeSchema as EnginePermissionModeSchema,
  ThinkingLevelSchema as EngineThinkingLevelSchema,
} from "@zvada/agent-server/protocol";
import type { PermissionMode, ThinkingLevel } from "@zvada/agent-server/protocol";

export const PermissionModeSchema = EnginePermissionModeSchema;
export type { PermissionMode };

export const ThinkingLevelSchema = EngineThinkingLevelSchema;
export type { ThinkingLevel };

/** Retired deus spellings → engine values. Read-time only; never written. */
const RETIRED_PERMISSION_MODES: Record<string, PermissionMode> = {
  acceptEdits: "accept_edits",
  bypassPermissions: "bypass_permissions",
  dontAsk: "dont_ask",
};

const RETIRED_THINKING_LEVELS: Record<string, ThinkingLevel> = {
  NONE: "off",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  XHIGH: "xhigh",
};

/** Normalize a stored/incoming permission mode; undefined when unrecognized. */
export function readPermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  const migrated = RETIRED_PERMISSION_MODES[value] ?? value;
  const parsed = PermissionModeSchema.safeParse(migrated);
  return parsed.success ? parsed.data : undefined;
}

/** Normalize a stored/incoming thinking level; undefined when unrecognized. */
export function readThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const migrated = RETIRED_THINKING_LEVELS[value] ?? value;
  const parsed = ThinkingLevelSchema.safeParse(migrated);
  return parsed.success ? parsed.data : undefined;
}

/** Runtime guard for settings validation (`default_thinking_level`). */
export const StoredThinkingLevelSchema = z
  .string()
  .transform((value) => readThinkingLevel(value))
  .refine((value): value is ThinkingLevel => value !== undefined, {
    message: "unknown thinking level",
  });
