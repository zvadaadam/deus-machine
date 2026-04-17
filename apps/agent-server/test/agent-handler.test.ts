import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerAgent,
  getAgent,
  initializeAllAgents,
  clearAgentRegistry,
  type AgentHandler,
} from "../agents/registry";

function createMockHandler(agentHarness: "claude" | "codex" = "claude"): AgentHandler {
  return {
    agentHarness,
    capabilities: {
      auth: false,
      workspaceInit: false,
      contextUsage: false,
      modelSwitch: "unsupported",
      multiTurn: false,
      sessionResume: false,
      permissionMode: false,
    },
    initialize: vi.fn(() => ({ success: true })),
    query: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(),
  };
}

describe("AgentRegistry", () => {
  beforeEach(() => {
    clearAgentRegistry();
  });

  // ==========================================================================
  // registerAgent / getAgent
  // ==========================================================================

  describe("registerAgent / getAgent", () => {
    it("registers and retrieves a handler", () => {
      const handler = createMockHandler("claude");
      registerAgent(handler);
      expect(getAgent("claude")).toBe(handler);
    });

    it("returns undefined for unregistered type", () => {
      expect(getAgent("codex")).toBeUndefined();
    });

    it("overwrites existing handler for same type", () => {
      const handler1 = createMockHandler("claude");
      const handler2 = createMockHandler("claude");
      registerAgent(handler1);
      registerAgent(handler2);
      expect(getAgent("claude")).toBe(handler2);
    });

    it("supports multiple agent types simultaneously", () => {
      const claude = createMockHandler("claude");
      const codex = createMockHandler("codex");
      registerAgent(claude);
      registerAgent(codex);
      expect(getAgent("claude")).toBe(claude);
      expect(getAgent("codex")).toBe(codex);
    });
  });

  // ==========================================================================
  // initializeAllAgents
  // ==========================================================================

  describe("initializeAllAgents", () => {
    it("initializes all registered agents", () => {
      const claude = createMockHandler("claude");
      const codex = createMockHandler("codex");
      registerAgent(claude);
      registerAgent(codex);

      const results = initializeAllAgents();

      expect(claude.initialize).toHaveBeenCalledOnce();
      expect(codex.initialize).toHaveBeenCalledOnce();
      expect(results.get("claude")).toEqual({ success: true });
      expect(results.get("codex")).toEqual({ success: true });
    });

    it("returns empty map when no agents registered", () => {
      const results = initializeAllAgents();
      expect(results.size).toBe(0);
    });

    it("captures initialization failures", () => {
      const handler = createMockHandler("claude");
      (handler.initialize as any).mockReturnValue({ success: false, error: "Not found" });
      registerAgent(handler);

      const results = initializeAllAgents();
      expect(results.get("claude")).toEqual({ success: false, error: "Not found" });
    });

    it("handles thrown errors during initialization", () => {
      const handler = createMockHandler("claude");
      (handler.initialize as any).mockImplementation(() => {
        throw new Error("Crash during init");
      });
      registerAgent(handler);

      const results = initializeAllAgents();
      expect(results.get("claude")).toEqual({
        success: false,
        error: "Crash during init",
      });
    });

    it("continues initializing other agents when one fails", () => {
      const claude = createMockHandler("claude");
      const codex = createMockHandler("codex");
      (claude.initialize as any).mockImplementation(() => {
        throw new Error("Claude failed");
      });
      registerAgent(claude);
      registerAgent(codex);

      const results = initializeAllAgents();
      expect(results.get("claude")?.success).toBe(false);
      expect(results.get("codex")?.success).toBe(true);
    });
  });

  // ==========================================================================
  // clearAgentRegistry
  // ==========================================================================

  describe("clearAgentRegistry", () => {
    it("removes all registered agents", () => {
      registerAgent(createMockHandler("claude"));
      registerAgent(createMockHandler("codex"));
      clearAgentRegistry();
      expect(getAgent("claude")).toBeUndefined();
      expect(getAgent("codex")).toBeUndefined();
    });
  });

  // ==========================================================================
  // AgentHandler interface contract
  // ==========================================================================

  describe("handler interface contract", () => {
    it("exposes capabilities on the handler", () => {
      const handler = createMockHandler("claude");
      registerAgent(handler);
      const agent = getAgent("claude")!;
      expect(agent.capabilities).toBeDefined();
      expect(typeof agent.capabilities.auth).toBe("boolean");
      expect(typeof agent.capabilities.workspaceInit).toBe("boolean");
      expect(typeof agent.capabilities.contextUsage).toBe("boolean");
      expect(typeof agent.capabilities.permissionMode).toBe("boolean");
    });

    it("handler methods can be called through registry", async () => {
      const handler = createMockHandler("claude");
      registerAgent(handler);

      const agent = getAgent("claude")!;
      agent.initialize();
      await agent.query("sess-1", "hello", { cwd: "/test" });
      await agent.cancel("sess-1");
      agent.reset("sess-1");

      expect(handler.initialize).toHaveBeenCalled();
      expect(handler.query).toHaveBeenCalledWith("sess-1", "hello", { cwd: "/test" });
      expect(handler.cancel).toHaveBeenCalledWith("sess-1");
      expect(handler.reset).toHaveBeenCalledWith("sess-1");
    });
  });
});
