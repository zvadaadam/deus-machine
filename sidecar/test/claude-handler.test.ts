import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock setup — must come before importing the module under test
// vi.hoisted() ensures variables are available when vi.mock factories run.
// ============================================================================

const { mockClaudeSDK, mockFrontendAPI, mockExecSync } = vi.hoisted(() => ({
  mockClaudeSDK: vi.fn(),
  mockFrontendAPI: {
    sendMessage: vi.fn(),
    sendError: vi.fn(),
    sendEnterPlanModeNotification: vi.fn(),
    requestExitPlanMode: vi.fn(),
    attachTunnel: vi.fn(),
    detachTunnel: vi.fn(),
  },
  mockExecSync: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    query: mockClaudeSDK,
  };
});

vi.mock("../frontend-client", () => ({
  FrontendClient: mockFrontendAPI,
}));

vi.mock("../agents/shell-env", () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: "/usr/bin", HOME: "/home/test" })),
}));

vi.mock("../agents/claude/checkpoint", () => ({
  createCheckpoint: vi.fn(),
}));

vi.mock("../agents/conductor-tools", () => ({
  createConductorMCPServer: vi.fn(() => ({ type: "sdk", name: "conductor" })),
}));

vi.mock("child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    realpathSync: vi.fn((p: string) => p),
  };
});

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import { parseEnvString } from "../agents/env-builder";
import { initializeClaude } from "../agents/claude/claude-discovery";
import { ClaudeAgentHandler } from "../agents/claude/claude-handler";
import { createCheckpoint } from "../agents/claude/checkpoint";

// Create handler instance (same pattern as index.ts)
const handler = new ClaudeAgentHandler();

// ============================================================================
// Tests
// ============================================================================

describe("claude-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // parseEnvString
  // ==========================================================================

  describe("parseEnvString", () => {
    it("parses simple KEY=value pairs", () => {
      const result = parseEnvString("FOO=bar\nBAZ=qux");
      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("handles export prefix", () => {
      const result = parseEnvString("export FOO=bar\nexport BAZ=qux");
      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("ignores comment lines", () => {
      const result = parseEnvString("# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux");
      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("ignores empty lines", () => {
      const result = parseEnvString("\nFOO=bar\n\n\nBAZ=qux\n");
      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("handles double-quoted values", () => {
      const result = parseEnvString('FOO="hello world"');
      expect(result).toEqual({ FOO: "hello world" });
    });

    it("handles single-quoted values", () => {
      const result = parseEnvString("FOO='hello world'");
      expect(result).toEqual({ FOO: "hello world" });
    });

    it("handles multi-line quoted values", () => {
      const result = parseEnvString('FOO="line1\nline2"');
      expect(result).toEqual({ FOO: "line1\nline2" });
    });

    it("skips lines without equals sign", () => {
      const result = parseEnvString("FOO=bar\nINVALID_LINE\nBAZ=qux");
      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("handles values with equals signs", () => {
      const result = parseEnvString("FOO=bar=baz=qux");
      expect(result).toEqual({ FOO: "bar=baz=qux" });
    });

    it("handles empty values", () => {
      const result = parseEnvString("FOO=");
      expect(result).toEqual({ FOO: "" });
    });

    it("handles empty input", () => {
      const result = parseEnvString("");
      expect(result).toEqual({});
    });

    it("trims whitespace from keys and values", () => {
      const result = parseEnvString("  FOO  =  bar  ");
      expect(result).toEqual({ FOO: "bar" });
    });
  });

  // ==========================================================================
  // initializeClaudeHandler
  // ==========================================================================

  describe("initializeClaude", () => {
    it("succeeds when claude executable is found", () => {
      mockExecSync.mockReturnValue("1.0.0\n");
      const result = initializeClaude();
      expect(result.success).toBe(true);
    });

    it("fails when no executable is found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = initializeClaude();
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to find Claude executable");
    });

    it("tries multiple candidate paths", () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        // Fail on first candidate, succeed on second
        if (callCount < 2) throw new Error("not found");
        return "1.0.0";
      });
      const result = initializeClaude();
      expect(result.success).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================================================
  // handleResetGenerator
  // ==========================================================================

  describe("handleResetGenerator", () => {
    it("does nothing when session does not exist", () => {
      expect(() => handler.handleReset("nonexistent")).not.toThrow();
    });
  });

  // ==========================================================================
  // handleClaudeQuery (requires successful init)
  // ==========================================================================

  describe("handleClaudeQuery", () => {
    beforeEach(() => {
      // Initialize successfully first
      mockExecSync.mockReturnValue("1.0.0\n");
      initializeClaude();
    });

    it("blocks query when initialization failed", async () => {
      // Reset to failed state
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      initializeClaude();

      await handler.handleQuery("sess-1", "hello", { cwd: "/test" });

      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-1",
          type: "error",
          agentType: "claude",
        })
      );
    });

    it("creates a new generator for a new session", async () => {
      // Mock SDK to return an async iterable that yields one message then completes
      const mockMessages = [
        { type: "assistant", message: { role: "assistant", content: "Hi" } },
      ];
      const mockQuery = {
        [Symbol.asyncIterator]: () => {
          let idx = 0;
          return {
            next: async () => {
              if (idx < mockMessages.length) {
                return { value: mockMessages[idx++], done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-new", "hello", {
        cwd: "/test",
        model: "sonnet",
        turnId: "turn-1",
      });

      // Allow generator to run
      await new Promise((r) => setTimeout(r, 100));

      expect(mockClaudeSDK).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            cwd: "/test",
          }),
        })
      );
    });

    it("passes correct SDK options including disallowedTools", async () => {
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-opts", "hello", {
        cwd: "/test",
        model: "sonnet",
        permissionMode: "plan",
        maxTurns: 50,
        maxThinkingTokens: 8000,
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.disallowedTools).toContain("AskUserQuestion");
      expect(sdkCall.options.permissionMode).toBe("plan");
      expect(sdkCall.options.maxTurns).toBe(50);
      expect(sdkCall.options.maxThinkingTokens).toBe(8000);
    });

    it("includes MCP server when strictDataPrivacy is false", async () => {
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-mcp", "hello", {
        cwd: "/test",
        strictDataPrivacy: false,
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.mcpServers).toBeDefined();
      expect(sdkCall.options.mcpServers.conductor).toBeDefined();
    });

    it("excludes MCP server when strictDataPrivacy is true", async () => {
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-privacy", "hello", {
        cwd: "/test",
        strictDataPrivacy: true,
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.mcpServers).toBeUndefined();
    });

    it("streams messages back to frontend via FrontendClient.sendMessage", async () => {
      const mockMessages = [
        { type: "assistant", message: { role: "assistant", content: "Hello" } },
        { type: "result", session_id: "sdk-123" },
      ];
      const mockQuery = {
        [Symbol.asyncIterator]: () => {
          let idx = 0;
          return {
            next: async () => {
              if (idx < mockMessages.length) {
                return { value: mockMessages[idx++], done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-stream", "hello", { cwd: "/test", turnId: "turn-1" });

      // Wait for the generator to complete
      await new Promise((r) => setTimeout(r, 200));

      expect(mockFrontendAPI.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-stream",
          type: "message",
          agentType: "claude",
        })
      );
    });

    it("sends error to frontend when SDK throws", async () => {
      mockClaudeSDK.mockImplementation(() => {
        throw new Error("SDK initialization failed");
      });

      await handler.handleQuery("sess-err", "hello", { cwd: "/test", turnId: "turn-1" });

      await new Promise((r) => setTimeout(r, 100));

      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-err",
          type: "error",
          error: "SDK initialization failed",
        })
      );
    });

    it("applies claudeEnvVars to SDK environment", async () => {
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-env", "hello", {
        cwd: "/test",
        claudeEnvVars: "CUSTOM_VAR=custom_value\nANOTHER=123",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.env.CUSTOM_VAR).toBe("custom_value");
      expect(sdkCall.options.env.ANOTHER).toBe("123");
    });

    it("sets GH_TOKEN in environment when provided", async () => {
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-gh", "hello", {
        cwd: "/test",
        ghToken: "my-gh-token",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.env.GH_TOKEN).toBe("my-gh-token");
    });
  });

  // ==========================================================================
  // handleClaudeCancel
  // ==========================================================================

  describe("handleClaudeCancel", () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue("1.0.0\n");
      initializeClaude();
    });

    it("does nothing when session does not exist", async () => {
      await handler.handleCancel("nonexistent");
      expect(mockFrontendAPI.sendError).not.toHaveBeenCalled();
    });

    it("blocks cancel when initialization failed", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      initializeClaude();

      await handler.handleCancel("sess-1");
      expect(mockFrontendAPI.sendError).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // handleClaudeUpdatePermissionMode
  // ==========================================================================

  describe("handleClaudeUpdatePermissionMode", () => {
    it("does nothing when session does not exist", async () => {
      await handler.updatePermissionMode("nonexistent", "plan");
      // Should not throw
    });
  });
});
