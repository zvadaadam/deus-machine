import { describe, expect, it, vi } from "vitest";
import type { ProjectToolSource } from "../agents/deus-tools/projects";

const { createAgentRegistry, createDeusMCPServer } = vi.hoisted(() => ({
  createAgentRegistry: vi.fn((_options: unknown) => ({})),
  createDeusMCPServer: vi.fn((_sessionId: string, _source: ProjectToolSource) => ({})),
}));
vi.mock("@zvada/agent-server/core", () => ({ createAgentRegistry, AgentRuntime: vi.fn() }));
vi.mock("../agents/deus-tools", () => ({ createDeusMCPServer }));
vi.mock("../agents/core/checkpoint", () => ({ createCheckpoint: vi.fn() }));
vi.mock("../agents/core/tool-policy", () => ({ decideToolUse: vi.fn() }));

import { getRegistry } from "../agents/core/engine";

describe("Project MCP engine binding", () => {
  it("keeps each MCP server bound to its originating engine instance when a session is replaced", () => {
    getRegistry();
    const { claudeCode } = createAgentRegistry.mock.calls[0][0] as {
      claudeCode: {
        sdkMcpServers: (context: { sessionId: string }) => unknown;
        hooks: (context: { sessionId: string; currentTurnId: () => string | undefined }) => unknown;
      };
    };

    claudeCode.sdkMcpServers({ sessionId: "session-1" });
    const first = createDeusMCPServer.mock.calls[0][1] as ProjectToolSource;
    expect(first.currentTurnId()).toBeUndefined();
    claudeCode.hooks({ sessionId: "session-1", currentTurnId: () => "original-turn" });
    expect(first.currentTurnId()).toBe("original-turn");

    claudeCode.sdkMcpServers({ sessionId: "session-1" });
    const replacement = createDeusMCPServer.mock.calls[1][1] as ProjectToolSource;
    claudeCode.hooks({ sessionId: "session-1", currentTurnId: () => "replacement-turn" });

    expect(first.currentTurnId()).toBe("original-turn");
    expect(replacement.currentTurnId()).toBe("replacement-turn");
  });
});
