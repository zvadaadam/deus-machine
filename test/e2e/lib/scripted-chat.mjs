import { mock } from "node:test";
import {
  AgentRegistry,
  AgentRuntime,
  ScriptedAgent,
  createScriptedTransformer,
} from "@zvada/agent-server/core";

/** Run the production tool and event paths with a deterministic local agent. */
export async function installScriptedChat(turn) {
  const { AgentLink } = await import("../../../apps/backend/src/services/agent/client.ts");
  const { chatTools } = await import("../../../apps/agent-server/host-link.ts");
  const { deusTools } = await import("../../../apps/agent-server/agents/deus-tools/index.ts");
  // Home offers the three product harnesses. Use the engine’s test agent in the default picker slot.
  class LocalFixture extends ScriptedAgent {
    harness = "claude-code";
    async listModels() {
      return [
        {
          id: "sonnet",
          harness: this.harness,
          label: "Sonnet",
          isDefault: true,
          thinking: { levels: [] },
        },
      ];
    }
  }
  const agent = new LocalFixture({
    turn,
    hostTools: ({ sessionId }) => chatTools(sessionId, deusTools(sessionId)),
  });
  const runtime = new AgentRuntime(new AgentRegistry().register(agent, createScriptedTransformer));
  const original = AgentLink.open.bind(AgentLink);
  mock.method(AgentLink, "open", (options) => original(options, runtime));
}
