import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock setup — must come before importing the module under test
// vi.hoisted() ensures variables are available when vi.mock factories run.
// ============================================================================

const { mockClaudeSDK, mockFrontendAPI, mockExecSync, mockExecFileSync, mockSessionWriter } =
  vi.hoisted(() => ({
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
    mockExecFileSync: vi.fn(),
    mockSessionWriter: {
      saveAssistantMessage: vi.fn((..._args: unknown[]) => ({ ok: true, value: "msg-id" })),
      saveToolResultMessage: vi.fn((..._args: unknown[]) => ({ ok: true, value: "msg-id" })),
      saveAgentSessionId: vi.fn((..._args: unknown[]) => ({ ok: true, value: "sess-id" })),
      lookupAgentSessionId: vi.fn((..._args: unknown[]): string | null => null),
      updateSessionStatus: vi.fn((..._args: unknown[]) => ({ ok: true, value: "sess-id" })),
      reconcileStuckSessions: vi.fn((..._args: unknown[]) => ({ ok: true, value: 0 })),
    },
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

vi.mock("../db/session-writer", () => mockSessionWriter);

vi.mock("../agents/opendevs-tools", () => ({
  createOpenDevsMCPServer: vi.fn(() => ({ type: "sdk", name: "opendevs" })),
}));

vi.mock("child_process", () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
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
  // initializeClaude
  // ==========================================================================

  describe("initializeClaude", () => {
    it("succeeds when claude executable is found", () => {
      mockExecSync.mockReturnValue("1.0.0\n");
      mockExecFileSync.mockReturnValue("1.0.0\n");
      const result = initializeClaude();
      expect(result.success).toBe(true);
    });

    it("fails when no executable is found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = initializeClaude();
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to find Claude executable");
    });

    it("tries multiple candidate paths", () => {
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
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
      mockExecFileSync.mockReturnValue("1.0.0\n");
      initializeClaude();
    });

    it("blocks query when initialization failed", async () => {
      // Reset to failed state
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockExecFileSync.mockImplementation(() => {
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
      const mockMessages = [{ type: "assistant", message: { role: "assistant", content: "Hi" } }];
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
      expect(sdkCall.options.mcpServers.opendevs).toBeDefined();
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

    it("does not send error when process exits after successful query (result/success received)", async () => {
      let callCount = 0;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (callCount === 0) {
              callCount++;
              return { value: { type: "result", subtype: "success" }, done: false };
            }
            throw new Error("Claude Code process terminated by signal SIGINT");
          },
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-sigint", "hello", { cwd: "/test", turnId: "turn-1" });

      await new Promise((r) => setTimeout(r, 100));

      expect(mockFrontendAPI.sendError).not.toHaveBeenCalled();
    });

    it("sends error when process exits before query succeeds (no result/success received)", async () => {
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("Claude Code process terminated by signal SIGINT");
          },
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-sigint-err", "hello", { cwd: "/test", turnId: "turn-1" });

      await new Promise((r) => setTimeout(r, 100));

      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-sigint-err",
          type: "error",
          error: expect.stringContaining("Claude Code process terminated by signal SIGINT"),
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

    it("preserves error status when stop_reason is max_tokens (does not overwrite with idle)", async () => {
      // Simulate SDK yielding: assistant msg with max_tokens → result/success
      const mockMessages = [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Truncated response..." }],
            stop_reason: "max_tokens",
          },
        },
        { type: "result", subtype: "success" },
      ];
      let idx = 0;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx < mockMessages.length) {
              return { value: mockMessages[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-max-tokens", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      // Should have sent an error event for max_tokens
      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-max-tokens",
          type: "error",
          category: "context_limit",
        })
      );

      // updateSessionStatus should have been called with "error" for max_tokens
      expect(mockSessionWriter.updateSessionStatus).toHaveBeenCalledWith(
        "sess-max-tokens",
        "error",
        expect.stringContaining("output token limit"),
        "context_limit"
      );

      // Crucially: updateSessionStatus should NOT have been called with "idle"
      // after being called with "error" — the stopReasonError flag must prevent it
      const statusCalls = mockSessionWriter.updateSessionStatus.mock.calls.filter(
        (call: unknown[]) => call[0] === "sess-max-tokens"
      );
      const lastStatusCall = statusCalls[statusCalls.length - 1];
      expect(lastStatusCall[1]).toBe("error");
    });
  });

  // ==========================================================================
  // Edge cases: processWithGenerator integration
  // ==========================================================================

  describe("edge cases", () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue("1.0.0\n");
      mockExecFileSync.mockReturnValue("1.0.0\n");
      initializeClaude();
    });

    it("does NOT capture agent_session_id when resume option is set", async () => {
      const mockMessages = [
        {
          type: "assistant",
          message: { role: "assistant", content: "hi" },
          session_id: "new-sdk-sess",
        },
        { type: "result", subtype: "success" },
      ];
      let idx = 0;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx < mockMessages.length) {
              return { value: mockMessages[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-resume", "hello", {
        cwd: "/test",
        resume: "original-agent-sess-id",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      // When resuming, we must NOT capture the new session_id — it would
      // overwrite the original working agent_session_id
      expect(mockSessionWriter.saveAgentSessionId).not.toHaveBeenCalled();
    });

    it("auto-injects resume when lookupAgentSessionId returns a saved ID", async () => {
      mockSessionWriter.lookupAgentSessionId.mockReturnValueOnce("saved-agent-sess-123");
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

      await handler.handleQuery("sess-auto-resume", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.resume).toBe("saved-agent-sess-123");
    });

    it("captures agent_session_id on first message for new sessions", async () => {
      const mockMessages = [
        {
          type: "assistant",
          message: { role: "assistant", content: "hi" },
          session_id: "sdk-sess-new",
        },
        { type: "result", subtype: "success" },
      ];
      let idx = 0;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx < mockMessages.length) {
              return { value: mockMessages[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-capture", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(mockSessionWriter.saveAgentSessionId).toHaveBeenCalledWith(
        "sess-capture",
        "sdk-sess-new"
      );
    });

    it("result/error_during_execution is logged and does not send idle", async () => {
      const mockMessages = [
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID: abc-123"],
          session_id: "sdk-err",
        },
      ];
      let idx = 0;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx < mockMessages.length) {
              return { value: mockMessages[idx++], done: false };
            }
            // Exit after the error result — simulates CLI exit with code 1
            throw new Error("Claude Code process exited with code 1");
          },
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-exec-err", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      // Should NOT have set status to "idle" — there was an error
      const idleCalls = mockSessionWriter.updateSessionStatus.mock.calls.filter(
        (call: unknown[]) => call[0] === "sess-exec-err" && call[1] === "idle"
      );
      expect(idleCalls).toHaveLength(0);

      // Should have sent an error notification
      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-exec-err",
          type: "error",
        })
      );
    });

    it("cancel via throw path persists cancellation message", async () => {
      let queryResolve: (() => void) | null = null;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              queryResolve = () => resolve({ value: undefined, done: true });
            }),
        }),
        close: vi.fn(),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-cancel-throw", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      // Let the generator start
      await new Promise((r) => setTimeout(r, 50));

      // Cancel the session — this sets cancelledByUser and terminates
      await handler.handleCancel("sess-cancel-throw");

      // Let the cancellation propagate
      await new Promise((r) => setTimeout(r, 100));

      // Verify checkpoint was created before kill
      expect(createCheckpoint).toHaveBeenCalledWith(
        "sess-cancel-throw",
        "turn-1",
        "end",
        "/test",
        "claudeHandler"
      );
    });

    it("sendMessage after terminate is silently dropped (push-after-close)", async () => {
      let queryStarted = false;
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            queryStarted = true;
            // Simulate a long-running query
            await new Promise((r) => setTimeout(r, 500));
            return { value: undefined, done: true };
          },
        }),
        close: vi.fn(),
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockClaudeSDK.mockReturnValue(mockQuery);

      await handler.handleQuery("sess-push-closed", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      // Let the generator start
      await new Promise((r) => setTimeout(r, 50));

      // Cancel (closes the queue via terminateSession → sendTerminate → promptQueue.close())
      await handler.handleCancel("sess-push-closed");

      // Let the cancellation propagate
      await new Promise((r) => setTimeout(r, 100));

      // Verify cancellation flow completed: checkpoint was created
      expect(createCheckpoint).toHaveBeenCalledWith(
        "sess-push-closed",
        "turn-1",
        "end",
        "/test",
        "claudeHandler"
      );

      // No unexpected errors sent to frontend during push-after-close
      expect(mockFrontendAPI.sendError).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // handleClaudeCancel
  // ==========================================================================

  describe("handleClaudeCancel", () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue("1.0.0\n");
      mockExecFileSync.mockReturnValue("1.0.0\n");
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
      mockExecFileSync.mockImplementation(() => {
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
