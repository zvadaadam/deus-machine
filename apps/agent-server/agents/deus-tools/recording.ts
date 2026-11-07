// agent-server/agents/deus-tools/recording.ts
// Screen recording for Deus sessions. The tools themselves — names,
// descriptions, behavior — come from @deus/screen-studio, the same set every
// host exposes. Deus supplies what is its own: the session's browser tab or
// simulator, where bundles live, and how a browser ref becomes a box.
//
// A browser recording watches the page's own input, so browser tools report
// nothing. Simulators have no page to watch: the simulator tools report their
// touches through recordSimulatorAction.

import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { createAgentTools, type ActionType } from "../../../../packages/screen-studio/src/index";
import { getElementBox, getRecordingTarget } from "./agent-browser-client";
import * as SimOps from "./sim-ops";
import type { SimulatorToolAction } from "./simulator";
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
          return {
            kind: "ios-simulator",
            udid: await SimOps.resolveDevice(destination, sessionId),
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

const SIMULATOR_ACTIONS: Record<string, ActionType> = {
  SimulatorTap: "tap",
  SimulatorTypeText: "type",
  SimulatorSwipe: "swipe",
  SimulatorPressKey: "key",
};

export function recordSimulatorAction(sessionId: string, action: SimulatorToolAction): void {
  const agentTools = sessions.get(sessionId);
  const source = agentTools?.current()?.manifest.source;
  const type = SIMULATOR_ACTIONS[action.toolName];
  // The agent may spell a UDID in any case; the recording keeps the device list's.
  const udid = String(source?.details.udid ?? "").toUpperCase();
  if (!type || source?.kind !== "ios-simulator" || udid !== action.udid.toUpperCase()) return;
  // Simulator tools work in iOS points, the recording's viewport space.
  agentTools!.recordAction({
    type,
    at: action.startedAt,
    endAt: Date.now(),
    ...(action.point ? { point: action.point } : {}),
    ...(action.path ? { path: action.path } : {}),
    ...(action.label ? { label: action.label } : {}),
  });
}

/** The recording tools for a Deus session, registered with the Claude SDK. */
export function createRecordingTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return toolsFor(sessionId).tools.map((definition) =>
    tool(definition.name, definition.description, definition.inputSchema, (args) =>
      definition.handler(args as Record<string, unknown>)
    )
  );
}
