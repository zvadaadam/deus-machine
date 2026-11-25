import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures mockFrontendAPI is available when the vi.mock factory runs (local mock variable name kept for brevity)
const { mockFrontendAPI } = vi.hoisted(() => ({
  mockFrontendAPI: {
    hasAgentMessages: vi.fn(() => false),
    requestGetDiff: vi.fn(),
    requestDiffComment: vi.fn(),
    requestGetTerminalOutput: vi.fn(),
  },
}));
vi.mock("../host-link", () => ({
  HostRpc: mockFrontendAPI,
  notifyTitle: vi.fn(),
}));

import type { HostToolSource } from "@zvada/agent-server/core";
import { TELL_USER } from "@shared/agent-message";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { deusTools } from "../agents/deus-tools";

const CALLER = {
  sessionId: "test-session-123",
  harness: "codex-app-server" as const,
  turnId: "turn",
  permissionMode: "default" as const,
};

/** Each tool of the source by name, called as the engine calls it. */
function getRegisteredTools(source: HostToolSource): Record<string, any> {
  return Object.fromEntries(
    source.tools.map((tool) => [
      tool.name,
      {
        ...tool,
        handler: (args: Record<string, unknown>) =>
          source.call(tool.name, args, CALLER, new AbortController().signal),
      },
    ])
  );
}

describe("deusTools", () => {
  const SESSION_ID = "test-session-123";
  let server: HostToolSource;

  beforeEach(() => {
    vi.clearAllMocks();
    server = deusTools(SESSION_ID);
  });

  it("is one source the engine gives every harness, its arguments described in JSON Schema", async () => {
    expect(server.name).toBe(DEUS_TOOLS_SERVER);
    const diff = server.tools.find((tool) => tool.name === "GetWorkspaceDiff")!;
    expect(diff.inputSchema).toMatchObject({
      type: "object",
      properties: {
        file: { type: "string", description: expect.stringContaining("relative to the workspace") },
        stat: { type: "boolean" },
      },
    });
    expect(diff.inputSchema).not.toHaveProperty("$schema");
    // A call's arguments are checked before the tool runs.
    await expect(
      getRegisteredTools(server).GetWorkspaceDiff.handler({ stat: "yes" })
    ).rejects.toThrow();
    expect(mockFrontendAPI.requestGetDiff).not.toHaveBeenCalled();
  });

  it("registers all workspace + browser + recording tools", () => {
    const tools = getRegisteredTools(server);
    const toolNames = Object.keys(tools);
    expect(toolNames).toHaveLength(28);
    expect(toolNames).not.toContain(TELL_USER);
    // Workspace tools (questions are Claude's own AskUserQuestion, through the engine)
    expect(toolNames).not.toContain("AskUserQuestion");
    expect(toolNames).toContain("GetWorkspaceDiff");
    expect(toolNames).toContain("DiffComment");
    expect(toolNames).toContain("GetTerminalOutput");
    // Automations
    expect(toolNames).toContain("automation_update");
    // Browser tools
    expect(toolNames).toContain("BrowserSnapshot");
    expect(toolNames).toContain("BrowserClick");
    expect(toolNames).toContain("BrowserType");
    expect(toolNames).toContain("BrowserNavigate");
    expect(toolNames).toContain("BrowserWaitFor");
    expect(toolNames).toContain("BrowserBatchActions");
    expect(toolNames).toContain("BrowserEvaluate");
    expect(toolNames).toContain("BrowserPressKey");
    expect(toolNames).toContain("BrowserHover");
    expect(toolNames).toContain("BrowserSelectOption");
    expect(toolNames).toContain("BrowserNavigateBack");
    expect(toolNames).toContain("BrowserConsoleMessages");
    expect(toolNames).toContain("BrowserScreenshot");
    expect(toolNames).toContain("BrowserNetworkRequests");
    expect(toolNames).toContain("BrowserScroll");
    // Recording tools
    expect(toolNames).toContain("recording_start");
    expect(toolNames).toContain("recording_stop");
    expect(toolNames).toContain("recording_chapter");
    expect(toolNames).toContain("recording_status");
    expect(toolNames).toContain("recording_focus");
    expect(toolNames).toContain("recording_hold");
  });

  it("adds just the read-only message tool and checks its Markdown before confirming the send", async () => {
    mockFrontendAPI.hasAgentMessages.mockReturnValueOnce(true);
    const enabled = deusTools(SESSION_ID);
    expect(enabled.tools.map((t) => t.name)).toEqual([
      ...server.tools.map((t) => t.name),
      TELL_USER,
    ]);
    expect(enabled.tools.find((t) => t.name === TELL_USER)).toMatchObject({
      description: expect.stringContaining(
        "Sub-agents report to their caller instead of calling it."
      ),
      annotations: { readOnly: true },
      inputSchema: {
        required: ["message"],
        properties: {
          message: {
            type: "string",
            pattern: "\\S",
            maxLength: 100_000,
            description: expect.stringContaining("Markdown"),
          },
        },
      },
    });
    const caller = { ...CALLER, permissionMode: "plan" as const };
    const signal = new AbortController().signal;
    await expect(
      enabled.call(TELL_USER, { message: "**Tests passed.**" }, caller, signal)
    ).resolves.toEqual({
      content: [{ type: "text", text: "Message sent." }],
    });
    await expect(enabled.call(TELL_USER, { message: "\n  " }, caller, signal)).rejects.toThrow();
    await expect(server.call(TELL_USER, { message: "Update" }, caller, signal)).rejects.toThrow(
      "No Deus tool"
    );
  });

  // ==========================================================================
  // GetWorkspaceDiff
  // ==========================================================================

  describe("GetWorkspaceDiff", () => {
    it("lists changed paths when called without a file or stat", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({ diff: "file.ts\nother.ts" });

      const tool = getRegisteredTools(server)["GetWorkspaceDiff"];
      const result = await tool.handler({});

      expect(mockFrontendAPI.requestGetDiff).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        file: undefined,
        stat: undefined,
      });
      expect(tool.description).toContain("lists the changed paths");
      expect(result.content[0].text).toBe("file.ts\nother.ts");
    });

    it("passes stat parameter for stat output", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({
        diff: " file.ts | 2 +-\n 1 file changed",
      });

      const tool = getRegisteredTools(server)["GetWorkspaceDiff"];
      await tool.handler({ stat: true });

      expect(mockFrontendAPI.requestGetDiff).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        file: undefined,
        stat: true,
      });
    });

    it("returns error message when diff fails", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({
        error: "Git repository not found",
      });

      const tool = getRegisteredTools(server)["GetWorkspaceDiff"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("Error getting diff");
      expect(result.content[0].text).toContain("Git repository not found");
    });

    it("returns 'No changes found' when diff is empty", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({ diff: "" });

      const tool = getRegisteredTools(server)["GetWorkspaceDiff"];
      const result = await tool.handler({});

      expect(result.content[0].text).toBe("No changes found.");
    });
  });

  // ==========================================================================
  // DiffComment
  // ==========================================================================

  describe("DiffComment", () => {
    it("posts comments via EventBroadcaster", async () => {
      mockFrontendAPI.requestDiffComment.mockResolvedValue({ success: true });

      const comments = [
        { file: "src/index.ts", lineNumber: 10, body: "Fix this" },
        { file: "src/utils.ts", lineNumber: 25, body: "Consider refactoring" },
      ];

      const tool = getRegisteredTools(server)["DiffComment"];
      const result = await tool.handler({ comments });

      expect(mockFrontendAPI.requestDiffComment).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        comments,
      });
      expect(result.content[0].text).toContain("Posted 2 comment(s)");
    });

    it("returns failure message when posting fails", async () => {
      mockFrontendAPI.requestDiffComment.mockResolvedValue({ success: false });

      const tool = getRegisteredTools(server)["DiffComment"];
      const result = await tool.handler({
        comments: [{ file: "test.ts", lineNumber: 1, body: "test" }],
      });

      expect(result.content[0].text).toContain("Failed to post comments");
    });
  });

  // ==========================================================================
  // GetTerminalOutput
  // ==========================================================================

  describe("GetTerminalOutput", () => {
    it("returns terminal output with header", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "bun run test\n  PASS  src/test.ts",
        source: "terminal",
        isRunning: true,
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("[Terminal - running]");
      expect(result.content[0].text).toContain("bun run test");
    });

    it("returns spotlight source label", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "test output",
        source: "spotlight",
        isRunning: false,
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      const result = await tool.handler({ source: "spotlight" });

      expect(result.content[0].text).toContain("[Spotlight - stopped]");
    });

    it("returns run_script source label", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "server started",
        source: "run_script",
        isRunning: true,
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      const result = await tool.handler({ source: "run_script" });

      expect(result.content[0].text).toContain("[Run script - running]");
    });

    it("handles no terminal output available", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        source: "none",
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("No terminal output available");
    });

    it("handles error from frontend", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        error: "Terminal not found",
        source: "none",
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("Error getting terminal output");
    });

    it("passes maxLines parameter", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "line 1",
        source: "terminal",
        isRunning: false,
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      await tool.handler({ maxLines: 50 });

      expect(mockFrontendAPI.requestGetTerminalOutput).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        source: undefined,
        maxLines: 50,
      });
    });

    it("shows 'No output available yet' when source exists but output is empty", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "",
        source: "terminal",
        isRunning: true,
      });

      const tool = getRegisteredTools(server)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("No output available yet");
    });
  });
});
