// agent-server/agents/deus-tools/index.ts
// Composes workspace + browser + recording + automation tools into one source
// the engine gives every harness (`hostTools`): Claude runs it in process,
// Codex reaches it at the engine's loopback. Agents drive a simulator with the
// agent-device CLI, which Deus ships and the turn's instructions brief them on,
// not with tools of Deus's own.

import type { HostToolSource } from "@zvada/agent-server/core";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";
import { createAutomationTools } from "./automations";
import { createRecordingTools } from "./recording";

/** The Deus tools of one chat. */
export function deusTools(sessionId: string): HostToolSource {
  const tools = [
    ...createWorkspaceTools(sessionId),
    ...createBrowserTools(sessionId),
    ...createAutomationTools(sessionId),
    ...createRecordingTools(sessionId),
  ];
  return {
    name: DEUS_TOOLS_SERVER,
    tools,
    call: async (name, args) => {
      const found = tools.find((each) => each.name === name);
      if (!found) throw new Error(`No Deus tool ${name}`);
      return found.run(args);
    },
  };
}
