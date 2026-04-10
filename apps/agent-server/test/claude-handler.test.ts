import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";

// ============================================================================
// Mock setup — must come before importing the module under test
// vi.hoisted() ensures variables are available when vi.mock factories run.
// ============================================================================

const { mockClaudeSDK, mockFrontendAPI, mockExecSync, mockExecFileSync } = vi.hoisted(() => ({
  mockClaudeSDK: vi.fn(),
  mockFrontendAPI: {
    sendMessage: vi.fn(),
    sendError: vi.fn(),
    sendEnterPlanModeNotification: vi.fn(),
    requestExitPlanMode: vi.fn(),
    attachTunnel: vi.fn(),
    detachTunnel: vi.fn(),
    emitEvent: vi.fn(),
    emitSessionStarted: vi.fn(),
    emitSessionIdle: vi.fn(),
    emitSessionError: vi.fn(),
    emitSessionCancelled: vi.fn(),
    emitAssistantMessage: vi.fn(),
    emitToolResultMessage: vi.fn(),
    emitMessageResult: vi.fn(),
    emitMessageCancelled: vi.fn(),
    emitMessageParts: vi.fn(),
    emitMessagePartsFinished: vi.fn(),
    emitAgentSessionId: vi.fn(),
  },
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    query: mockClaudeSDK,
  };
});

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: mockFrontendAPI,
}));

vi.mock("../agents/environment/shell-env", () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: "/usr/bin", HOME: "/home/test" })),
}));

vi.mock("../agents/claude/checkpoint", () => ({
  createCheckpoint: vi.fn(),
}));

vi.mock("../agents/deus-tools", () => ({
  createDeusMCPServer: vi.fn(() => ({ type: "sdk", name: "deus" })),
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

import { parseEnvString } from "../agents/environment";
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
  // reset
  // ==========================================================================

  describe("reset", () => {
    it("does nothing when session does not exist", () => {
      expect(() => handler.reset("nonexistent")).not.toThrow();
    });
  });

  // ==========================================================================
  // handleClaudeQuery (requires successful init)
  // ==========================================================================

  describe("query", () => {
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

      await handler.query("sess-1", "hello", { cwd: "/test" });

      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-1",
          type: "error",
          agentType: "claude",
        })
      );
    });

    it("sends a clear error when the workspace path is missing", async () => {
      vi.mocked(fs.existsSync).mockImplementation((value: fs.PathLike) => value !== "/missing");

      await handler.query("sess-missing-cwd", "hello", { cwd: "/missing", turnId: "turn-1" });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockClaudeSDK).not.toHaveBeenCalled();
      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-missing-cwd",
          type: "error",
          error: expect.stringContaining("Workspace path does not exist: /missing"),
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

      await handler.query("sess-new", "hello", {
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

      await handler.query("sess-opts", "hello", {
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

      await handler.query("sess-mcp", "hello", {
        cwd: "/test",
        strictDataPrivacy: false,
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.mcpServers).toBeDefined();
      expect(sdkCall.options.mcpServers.deus).toBeDefined();
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

      await handler.query("sess-privacy", "hello", {
        cwd: "/test",
        strictDataPrivacy: true,
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 100));

      const sdkCall = mockClaudeSDK.mock.calls[0][0];
      expect(sdkCall.options.mcpServers).toBeUndefined();
    });

    it("streams messages back to frontend via EventBroadcaster.sendMessage", async () => {
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

      await handler.query("sess-stream", "hello", { cwd: "/test", turnId: "turn-1" });

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

      await handler.query("sess-err", "hello", { cwd: "/test", turnId: "turn-1" });

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

      await handler.query("sess-sigint", "hello", { cwd: "/test", turnId: "turn-1" });

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

      await handler.query("sess-sigint-err", "hello", { cwd: "/test", turnId: "turn-1" });

      await new Promise((r) => setTimeout(r, 100));

      expect(mockFrontendAPI.sendError).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sess-sigint-err",
          type: "error",
          error: expect.stringContaining("Claude Code process terminated by signal SIGINT"),
        })
      );
    });

    it("applies providerEnvVars to SDK environment", async () => {
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

      await handler.query("sess-env", "hello", {
        cwd: "/test",
        providerEnvVars: "CUSTOM_VAR=custom_value\nANOTHER=123",
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

      await handler.query("sess-gh", "hello", {
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

      await handler.query("sess-max-tokens", "hello", {
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

      // emitSessionError should have been called for stop_reason error
      expect(mockFrontendAPI.emitSessionError).toHaveBeenCalledWith(
        "sess-max-tokens",
        "claude",
        expect.stringContaining("output token limit"),
        "context_limit"
      );

      // Crucially: emitSessionIdle should NOT have been called after
      // emitSessionError — the stopReasonError flag must prevent it
      expect(mockFrontendAPI.emitSessionIdle).not.toHaveBeenCalled();
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

      await handler.query("sess-resume", "hello", {
        cwd: "/test",
        resume: "original-agent-sess-id",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      // When resuming, we must NOT capture the new session_id — it would
      // overwrite the original working agent_session_id
      expect(mockFrontendAPI.emitAgentSessionId).not.toHaveBeenCalled();
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

      await handler.query("sess-capture", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(mockFrontendAPI.emitAgentSessionId).toHaveBeenCalledWith(
        "sess-capture",
        "sdk-sess-new"
      );
    });

    it("result/error_during_execution is logged and does not emit idle", async () => {
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

      await handler.query("sess-exec-err", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      await new Promise((r) => setTimeout(r, 200));

      // Should NOT have emitted session.idle — there was an error
      expect(mockFrontendAPI.emitSessionIdle).not.toHaveBeenCalled();

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

      await handler.query("sess-cancel-throw", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      // Let the generator start
      await new Promise((r) => setTimeout(r, 50));

      // Cancel the session — this sets cancelledByUser and terminates
      await handler.cancel("sess-cancel-throw");

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

      await handler.query("sess-push-closed", "hello", {
        cwd: "/test",
        turnId: "turn-1",
      });

      // Let the generator start
      await new Promise((r) => setTimeout(r, 50));

      // Cancel (closes the queue via terminateSession → sendTerminate → promptQueue.close())
      await handler.cancel("sess-push-closed");

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

    it("emits message.parts alongside legacy events during streaming", async () => {
      const mockMessages = [
        {
          type: "assistant",
          message: {
            id: "msg_1",
            role: "assistant",
            content: [{ type: "text", text: "Hello from Parts" }],
          },
          parent_tool_use_id: null,
          session_id: "sdk-parts",
        },
        { type: "result", subtype: "success", session_id: "sdk-parts" },
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

      await handler.query("sess-parts", "hello", {
        cwd: "/test",
        turnId: "turn-parts",
      });

      await new Promise((r) => setTimeout(r, 200));

      // Legacy events should still fire
      expect(mockFrontendAPI.emitAssistantMessage).toHaveBeenCalled();
      expect(mockFrontendAPI.sendMessage).toHaveBeenCalled();

      // Parts events should also fire
      expect(mockFrontendAPI.emitMessageParts).toHaveBeenCalled();

      // Verify the Parts contain a TextPart with the right content
      const partsCalls = mockFrontendAPI.emitMessageParts.mock.calls;
      const allParts = partsCalls.flatMap((call: unknown[]) => call[3]);
      const textParts = allParts.filter((p: { type: string }) => p.type === "TEXT");
      expect(textParts.length).toBeGreaterThanOrEqual(1);
      expect(textParts[0].text).toBe("Hello from Parts");

      // Finished event should fire with usage info
      expect(mockFrontendAPI.emitMessagePartsFinished).toHaveBeenCalledWith(
        "sess-parts",
        "claude",
        expect.any(String),
        expect.objectContaining({ input: expect.any(Number), output: expect.any(Number) }),
        undefined,
        expect.any(String)
      );
    });
  });

  // ==========================================================================
  // handleClaudeCancel
  // ==========================================================================

  describe("cancel", () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue("1.0.0\n");
      mockExecFileSync.mockReturnValue("1.0.0\n");
      initializeClaude();
    });

    it("does nothing when session does not exist", async () => {
      await handler.cancel("nonexistent");
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

      await handler.cancel("sess-1");
      expect(mockFrontendAPI.sendError).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // handleClaudeUpdatePermissionMode
  // ==========================================================================

  describe("updatePermissionMode", () => {
    it("does nothing when session does not exist", async () => {
      await handler.updatePermissionMode("nonexistent", "plan");
      // Should not throw
    });
  });
});
