// agent-server/agents/deus-tools/recording.ts
// Screen recording for Deus sessions. The tools themselves — names,
// descriptions, behavior — come from @deus/screen-studio, the same set every
// host exposes. Deus supplies what is its own: the session's browser tab,
// where bundles live, and how a browser ref becomes a box.
//
// A browser recording watches the page's own input. A simulator recording is
// agent-device's, in the workspace's agent-device session (every turn's
// commands carry it as AGENT_DEVICE_SESSION), so its telemetry holds the
// agent's touches; it records the workspace's Simulator tab device unless the
// agent names another.

import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { createAgentTools } from "../../../../packages/screen-studio/src/index";
import { getElementBox, getRecordingTarget } from "./agent-browser-client";
import { HostRpc } from "../../host-link";
import { tool } from "./sdk-tool";

/** Under tmpdir: the backend's /files/stream only serves media from there. */
const RECORDINGS_DIR = join(tmpdir(), "deus-recordings");

type AgentTools = ReturnType<typeof createAgentTools>;

/** One tool set, and so at most one recording, per Deus session. */
const sessions = new Map<string, AgentTools>();

function toolsFor(sessionId: string): AgentTools {
  let agentTools = sessions.get(sessionId);
  if (!agentTools) {
    agentTools = createAgentTools({
      async resolveSource({ target, destination }) {
        if (target === "simulator") {
          const device = await HostRpc.requestAgentDevice({ sessionId });
          return {
            kind: "ios-simulator",
            udid: destination ?? device.udid ?? "booted",
            session: device.session,
          };
        }
        const page = await getRecordingTarget(sessionId);
        if (!page) {
          throw new Error(
            "No browser page to record. Open one with BrowserNavigate, then call recording_start."
          );
        }
        return {
          kind: "browser",
          endpoint: page.endpoint,
          ...(page.url ? { urlContains: page.url } : {}),
        };
      },
      bundleDir: () => join(RECORDINGS_DIR, `rec_${Date.now()}_${randomBytes(3).toString("hex")}`),
      resolveRef: (ref) => getElementBox(sessionId, ref),
    });
    sessions.set(sessionId, agentTools);
  }
  return agentTools;
}

/** The recording tools for a Deus session, registered with the Claude SDK. */
export function createRecordingTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return toolsFor(sessionId).tools.map((definition) =>
    tool(definition.name, definition.description, definition.inputSchema, (args) =>
      definition.handler(args as Record<string, unknown>)
    )
  );
}
