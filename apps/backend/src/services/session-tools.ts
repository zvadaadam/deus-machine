import type { HostToolSource } from "@zvada/agent-server/core";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { operatorTools } from "./assistants/operator";

export function sessionTools(_sessionId: string) {
  const operator = operatorTools();
  return {
    instructions: operator.instructions ?? "",
    compose(base: HostToolSource): HostToolSource {
      const tools = [...operator.tools, ...base.tools];
      const names = new Set<string>();
      for (const { name } of tools) {
        if (names.has(name)) throw new Error(`Duplicate chat tool: ${name}`);
        names.add(name);
      }
      return {
        ...base,
        name: DEUS_TOOLS_SERVER,
        tools,
        call(name, args, caller, signal) {
          const source = base.tools.some((tool) => tool.name === name) ? base : operator;
          return source.call(name, args, caller, signal);
        },
      };
    },
  };
}
