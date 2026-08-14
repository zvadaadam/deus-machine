/**
 * Part Streak Grouping
 *
 * Groups consecutive read-only TOOL parts into collapsible streaks.
 *
 * Groupable tools are read-only exploration tools (Read, Grep, Glob, etc.)
 * that produce visual noise when shown individually in long sequences.
 * Write/execute tools (Edit, Bash, Write) always render individually.
 *
 * Streak behavior:
 * - Trailing streak (at end of parts array) → unsealed (tools visible during streaming)
 * - Non-trailing streak (TEXT/REASONING follows) → sealed (tools collapsed under header)
 * - Threshold: 2+ tools to show group header
 */

import type { Part, ToolPart } from "@shared/protocol-types";

// ---- Read-only tool detection ----

/**
 * The protocol classifies what a call DOES (`kind`), so grouping keys off that
 * instead of a tool-name allowlist — an MCP tool nobody hardcoded still groups
 * correctly. The name list stays as the fallback for unkinded tools.
 */
const READ_ONLY_TOOL_KINDS: ReadonlySet<string> = new Set(["read", "search", "fetch"]);

const GROUPABLE_TOOL_NAMES = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

// ---- Types ----

export interface SinglePartItem {
  kind: "part";
  item: Part;
}

export interface PartToolStreak {
  kind: "tool-streak";
  parts: ToolPart[];
  firstPartId: string;
  isSealed: boolean;
}

export type GroupedPartItem = SinglePartItem | PartToolStreak;

// ---- Grouping ----

function isGroupableToolPart(part: Part): part is ToolPart {
  if (part.type !== "tool") return false;
  if (part.kind !== undefined) return READ_ONLY_TOOL_KINDS.has(part.kind);
  return GROUPABLE_TOOL_NAMES.has(part.toolName);
}

export function groupPartItems(parts: Part[], isStreamingTurn: boolean): GroupedPartItem[] {
  if (parts.length === 0) return [];

  const result: GroupedPartItem[] = [];
  let streak: ToolPart[] = [];

  const flushStreak = (isTrailing: boolean) => {
    if (streak.length === 0) return;
    result.push({
      kind: "tool-streak",
      parts: streak,
      firstPartId: streak[0].id,
      isSealed: !isTrailing || !isStreamingTurn,
    });
    streak = [];
  };

  for (const part of parts) {
    if (isGroupableToolPart(part)) {
      streak.push(part);
    } else {
      flushStreak(false);
      result.push({ kind: "part", item: part });
    }
  }

  flushStreak(true);

  return result;
}

export { GROUPABLE_TOOL_NAMES };
