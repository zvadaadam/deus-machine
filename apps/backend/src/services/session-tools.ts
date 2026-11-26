import type { HostToolSource } from "@zvada/agent-server/core";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { operatorTools } from "./assistants/operator";
import { boardSource } from "./boards/tools";

export function sessionTools(sessionId: string) {
  const operator = operatorTools(boardSource(sessionId));
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
