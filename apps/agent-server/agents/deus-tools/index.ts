// agent-server/agents/deus-tools/index.ts
// Composes workspace + browser + recording + automation tools into one source
// the engine gives every harness (`hostTools`): Claude runs it in process,
// Codex reaches it at the engine's loopback. Agents drive a simulator with the
// agent-device CLI, which Deus ships and the turn's instructions brief them on,
// not with tools of Deus's own.

import type { HostToolSource } from "@zvada/agent-server/core";
import { z } from "zod";
import { TELL_USER } from "@shared/agent-message";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { HostRpc } from "../../host-link";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";
import { createAutomationTools } from "./automations";
import { createRecordingTools } from "./recording";
import { tool } from "./tool";

const tellUser = tool(
  TELL_USER,
  "Send the person a message while you work, as complete Markdown. " +
    "Until you finish, only what you send appears to them; your final reply appears by itself, " +
    "so do not send it with this tool. Sub-agents report to their caller instead of calling it. " +
    "To message another chat, use `send_message`.",
  { message: z.string().regex(/\S/, "Write a message for the person.") },
  async () => ({ content: [{ type: "text", text: "Message sent." }] }),
  { readOnly: true }
);

/** The Deus tools of one chat. */
export function deusTools(sessionId: string): HostToolSource {
  const tools = [
    ...createWorkspaceTools(sessionId),
    ...createBrowserTools(sessionId),
    ...createAutomationTools(sessionId),
    ...createRecordingTools(sessionId),
  ];
  if (HostRpc.hasAgentMessages(sessionId)) tools.push(tellUser);
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
