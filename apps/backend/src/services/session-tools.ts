import type { HostToolSource } from "@zvada/agent-server/core";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { operatorTools } from "./assistants/operator";
import { withSeenNews } from "./boards/coordinator-wake";
import { boardSource } from "./boards/tools";

export function sessionTools(sessionId: string) {
  const board = boardSource(sessionId);
  // A coordinator's wait, start, send or read that shows a worker's news has delivered it.
  const operator = board ? withSeenNews(operatorTools(board)) : operatorTools();
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
