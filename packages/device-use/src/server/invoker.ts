// Central dispatcher. Every tool invocation — whether it came from HTTP,
// MCP, or the WS /ws endpoint — goes through this function. One path,
// one event trace.

import type { Context } from "./tools.js";
import { findTool } from "./tools.js";

export interface InvokeResult {
  tool: string;
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export async function invokeTool(
  ctx: Context,
  name: string,
  params: unknown
): Promise<InvokeResult> {
  const tool = findTool(name);
  const id = ctx.events.newId();
  const at = Date.now();
  if (!tool) {
    const error = `unknown tool: ${name}`;
    ctx.events.emit({ type: "tool-event", id, at, tool: name, params, status: "failed", error });
    return { tool: name, id, success: false, error };
  }

  let validatedParams: unknown;
  try {
    validatedParams = tool.schema.parse(params ?? {});
  } catch (err) {
    const error = `invalid params: ${(err as Error).message}`;
    ctx.events.emit({ type: "tool-event", id, at, tool: name, params, status: "failed", error });
    return { tool: name, id, success: false, error };
  }

  ctx.events.emit({
    type: "tool-event",
    id,
    at,
    tool: name,
    params: validatedParams,
    status: "started",
  });

  try {
    const result = await tool.handler(ctx, validatedParams);
    ctx.events.emit({
      type: "tool-event",
      id,
      at: Date.now(),
      tool: name,
      params: validatedParams,
      status: "completed",
      result,
    });
    return { tool: name, id, success: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.events.emit({
      type: "tool-event",
      id,
      at: Date.now(),
      tool: name,
      params: validatedParams,
      status: "failed",
      error,
    });
    return { tool: name, id, success: false, error };
  }
}
