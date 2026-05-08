// agent-server/messages/codex-part-helpers.ts
// Shared helpers for Codex-family adapters that emit unified ToolParts.

import type { Part, RunningToolState, ToolOutputContent, ToolPart } from "@shared/messages";
import type { PartEvent, StreamContext } from "./adapter";
import { completeToolPart, createToolPart } from "./parts";

type PartMaps = {
  parts: Map<string, Part>;
  itemParts: Map<string, string>;
};

export function startShellToolPart(
  ctx: StreamContext,
  maps: PartMaps,
  opts: { itemId: string; command: string; cwd?: string }
): PartEvent[] {
  const part = createToolPart(ctx.sessionId, ctx.messageId, {
    toolCallId: opts.itemId,
    toolName: "shell",
    kind: "bash",
    state: {
      status: "RUNNING",
      input: opts.cwd ? { command: opts.command, cwd: opts.cwd } : { command: opts.command },
      title: opts.command,
      time: { start: new Date().toISOString() },
    } satisfies RunningToolState,
  });
  part.title = opts.command;
  part.locations = opts.cwd ? [{ path: opts.cwd }] : undefined;

  return trackToolPart(maps, opts.itemId, part);
}

export function startFileChangeToolPart(
  ctx: StreamContext,
  maps: PartMaps,
  opts: { itemId: string; changes: unknown; paths: string[] }
): PartEvent[] {
  const title =
    opts.paths.length === 1 ? `Edit ${opts.paths[0]}` : `Edit ${opts.paths.length} files`;
  const part = createToolPart(ctx.sessionId, ctx.messageId, {
    toolCallId: opts.itemId,
    toolName: "apply_patch",
    kind: "write",
    state: {
      status: "RUNNING",
      input: opts.changes,
      title,
      time: { start: new Date().toISOString() },
    } satisfies RunningToolState,
  });
  part.title = title;
  part.locations = opts.paths.map((path) => ({ path }));

  return trackToolPart(maps, opts.itemId, part);
}

export function startMcpToolPart(
  ctx: StreamContext,
  maps: PartMaps,
  opts: { itemId: string; server: string; tool: string; input: unknown }
): PartEvent[] {
  const toolName = `${opts.server}/${opts.tool}`;
  const part = createToolPart(ctx.sessionId, ctx.messageId, {
    toolCallId: opts.itemId,
    toolName,
    kind: "mcp",
    state: {
      status: "RUNNING",
      input: opts.input,
      title: opts.tool,
      time: { start: new Date().toISOString() },
    } satisfies RunningToolState,
  });
  part.title = opts.tool;

  return trackToolPart(maps, opts.itemId, part);
}

export function completeTrackedToolPart(
  maps: PartMaps,
  itemId: string,
  output: unknown,
  isError: boolean,
  content?: ToolOutputContent[]
): PartEvent[] {
  const partId = maps.itemParts.get(itemId);
  if (!partId) return [];

  const existing = maps.parts.get(partId) as ToolPart | undefined;
  if (!existing) return [];

  const updated = completeToolPart(existing, output, isError);
  if (updated.state.status === "COMPLETED" && content && content.length > 0) {
    updated.state = { ...updated.state, content };
  }
  maps.parts.set(partId, updated);
  return [{ type: "part.done", part: updated }];
}

function trackToolPart(maps: PartMaps, itemId: string, part: ToolPart): PartEvent[] {
  maps.parts.set(part.id, part);
  maps.itemParts.set(itemId, part.id);
  return [{ type: "part.created", part }];
}
