import { z } from "zod";
import type { HostTool, HostToolResult } from "@zvada/agent-server/core";

/** A Deus tool: what the engine shows the agent, and how it runs. */
export interface DeusTool extends HostTool {
  run(args: Record<string, unknown>): Promise<HostToolResult>;
}

/**
 * A tool from its arguments' zod shape: the agent is shown its JSON Schema,
 * and a call's arguments are checked against it before the handler runs.
 */
export function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  // An MCP result's shape, which the tool modules build loosely: one cast, here.
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  annotations?: HostTool["annotations"]
): DeusTool {
  const schema = z.object(shape);
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
  return {
    name,
    description,
    inputSchema,
    annotations,
    run: async (args) => (await handler(schema.parse(args))) as HostToolResult,
  };
}
