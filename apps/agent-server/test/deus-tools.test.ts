import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures mockFrontendAPI is available when the vi.mock factory runs (local mock variable name kept for brevity)
const { mockFrontendAPI } = vi.hoisted(() => ({
  mockFrontendAPI: {
    requestAskUserQuestion: vi.fn(),
    requestGetDiff: vi.fn(),
    requestDiffComment: vi.fn(),
    requestGetTerminalOutput: vi.fn(),
    requestSimulatorContext: vi.fn(),
  },
}));
vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: mockFrontendAPI,
}));

// Mock agent-simulator/engine — the package only exports ESM, tests run in CJS context.
vi.mock("agent-simulator/engine", () => ({
  createExecutor: vi.fn(() => ({})),
  listSimulators: vi.fn(async () => []),
  bootSimulator: vi.fn(async () => {}),
  takeScreenshot: vi.fn(async () => {}),
  installApp: vi.fn(async () => {}),
  launchApp: vi.fn(async () => ""),
  terminateApp: vi.fn(async () => {}),
  uninstallApp: vi.fn(async () => {}),
  tap: vi.fn(async () => {}),
  tapByLabel: vi.fn(async () => {}),
  typeText: vi.fn(async () => {}),
  swipe: vi.fn(async () => {}),
  pressKey: vi.fn(async () => {}),
  pressButton: vi.fn(async () => {}),
  fetchAccessibilityTree: vi.fn(async () => []),
  filterInteractive: vi.fn(() => []),
  waitFor: vi.fn(async () => ({ found: true })),
  waitForLabel: vi.fn(async () => ({ found: true })),
  RefMap: vi.fn().mockImplementation(() => ({ assign: vi.fn(() => []) })),
  formatCompact: vi.fn(() => ""),
}));

import { createDeusMCPServer } from "../agents/deus-tools";

// Helpers to access McpServer internals (the real McpServer class uses private fields)
function getRegisteredTools(instance: any): Record<string, any> {
  return instance._registeredTools;
}

function getServerInfo(instance: any): { name: string; version: string } {
  return instance.server._serverInfo;
}

describe("createDeusMCPServer", () => {
  const SESSION_ID = "test-session-123";
  let server: ReturnType<typeof createDeusMCPServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createDeusMCPServer(SESSION_ID);
  });

  it("returns an SDK-compatible server descriptor", () => {
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("deus");
    expect(server.instance).toBeDefined();
    const info = getServerInfo(server.instance);
    expect(info.name).toBe("deus");
    expect(info.version).toBe("1.0.0");
  });

  it("registers all workspace + browser + simulator + recording tools", () => {
    const tools = getRegisteredTools(server.instance);
    const toolNames = Object.keys(tools);
    expect(toolNames).toHaveLength(37);
    // Workspace tools
    expect(toolNames).toContain("AskUserQuestion");
    expect(toolNames).toContain("GetWorkspaceDiff");
    expect(toolNames).toContain("DiffComment");
    expect(toolNames).toContain("GetTerminalOutput");
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
    // Simulator tools
    expect(toolNames).toContain("SimulatorListDevices");
    expect(toolNames).toContain("SimulatorScreenshot");
    expect(toolNames).toContain("SimulatorTap");
    expect(toolNames).toContain("SimulatorTypeText");
    expect(toolNames).toContain("SimulatorSwipe");
    expect(toolNames).toContain("SimulatorPressKey");
    expect(toolNames).toContain("SimulatorBuild");
    expect(toolNames).toContain("SimulatorLaunch");
    expect(toolNames).toContain("SimulatorReadScreen");
    expect(toolNames).toContain("SimulatorWaitFor");
    expect(toolNames).toContain("SimulatorGetProjectInfo");
    // Recording tools
    expect(toolNames).toContain("recording_start");
    expect(toolNames).toContain("recording_stop");
    expect(toolNames).toContain("recording_chapter");
    expect(toolNames).toContain("recording_status");
  });

  // ==========================================================================
  // AskUserQuestion
  // ==========================================================================

  describe("AskUserQuestion", () => {
    it("calls EventBroadcaster.requestAskUserQuestion with sessionId and questions", async () => {
      mockFrontendAPI.requestAskUserQuestion.mockResolvedValue({
        answers: ["Option A"],
      });

      const tool = getRegisteredTools(server.instance)["AskUserQuestion"];
      const result = await tool.handler({
        questions: [{ question: "Which option?", options: ["Option A", "Option B"] }],
      });

      expect(mockFrontendAPI.requestAskUserQuestion).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        questions: [{ question: "Which option?", options: ["Option A", "Option B"] }],
      });
      expect(result.content[0].text).toContain("User responses:");
      expect(result.content[0].text).toContain("Option A");
    });

    it("handles user cancellation", async () => {
      mockFrontendAPI.requestAskUserQuestion.mockResolvedValue({
        answers: ["USER_CANCELLED"],
      });

      const tool = getRegisteredTools(server.instance)["AskUserQuestion"];
      const result = await tool.handler({
        questions: [{ question: "Continue?", options: ["Yes", "No"] }],
      });

      expect(result.content[0].text).toContain("User cancelled");
    });

    it("formats multiple answers correctly", async () => {
      mockFrontendAPI.requestAskUserQuestion.mockResolvedValue({
        answers: ["Yes", "Blue"],
      });

      const tool = getRegisteredTools(server.instance)["AskUserQuestion"];
      const result = await tool.handler({
        questions: [
          { question: "Continue?", options: ["Yes", "No"] },
          { question: "Color?", options: ["Red", "Blue"] },
        ],
      });

      expect(result.content[0].text).toContain("1. Yes");
      expect(result.content[0].text).toContain("2. Blue");
    });

    it("formats multi-select array answers", async () => {
      mockFrontendAPI.requestAskUserQuestion.mockResolvedValue({
        answers: [["Option A", "Option C"]],
      });

      const tool = getRegisteredTools(server.instance)["AskUserQuestion"];
      const result = await tool.handler({
        questions: [
          {
            question: "Which?",
            options: ["Option A", "Option B", "Option C"],
            multiSelect: true,
          },
        ],
      });

      expect(result.content[0].text).toContain("Option A");
      expect(result.content[0].text).toContain("Option C");
    });
  });

  // ==========================================================================
  // GetWorkspaceDiff
  // ==========================================================================

  describe("GetWorkspaceDiff", () => {
    it("returns diff content from EventBroadcaster", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({
        diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      });

      const tool = getRegisteredTools(server.instance)["GetWorkspaceDiff"];
      const result = await tool.handler({});

      expect(mockFrontendAPI.requestGetDiff).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        file: undefined,
        stat: undefined,
      });
      expect(result.content[0].text).toContain("--- a/file.ts");
    });

    it("passes file parameter for single-file diff", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({ diff: "file diff" });

      const tool = getRegisteredTools(server.instance)["GetWorkspaceDiff"];
      await tool.handler({ file: "/path/to/file.ts" });

      expect(mockFrontendAPI.requestGetDiff).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        file: "/path/to/file.ts",
        stat: undefined,
      });
    });

    it("passes stat parameter for stat output", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({
        diff: " file.ts | 2 +-\n 1 file changed",
      });

      const tool = getRegisteredTools(server.instance)["GetWorkspaceDiff"];
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

      const tool = getRegisteredTools(server.instance)["GetWorkspaceDiff"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("Error getting diff");
      expect(result.content[0].text).toContain("Git repository not found");
    });

    it("returns 'No changes found' when diff is empty", async () => {
      mockFrontendAPI.requestGetDiff.mockResolvedValue({ diff: "" });

      const tool = getRegisteredTools(server.instance)["GetWorkspaceDiff"];
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

      const tool = getRegisteredTools(server.instance)["DiffComment"];
      const result = await tool.handler({ comments });

      expect(mockFrontendAPI.requestDiffComment).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        comments,
      });
      expect(result.content[0].text).toContain("Posted 2 comment(s)");
    });

    it("returns failure message when posting fails", async () => {
      mockFrontendAPI.requestDiffComment.mockResolvedValue({ success: false });

      const tool = getRegisteredTools(server.instance)["DiffComment"];
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

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
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

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
      const result = await tool.handler({ source: "spotlight" });

      expect(result.content[0].text).toContain("[Spotlight - stopped]");
    });

    it("returns run_script source label", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "server started",
        source: "run_script",
        isRunning: true,
      });

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
      const result = await tool.handler({ source: "run_script" });

      expect(result.content[0].text).toContain("[Run script - running]");
    });

    it("handles no terminal output available", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        source: "none",
      });

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("No terminal output available");
    });

    it("handles error from frontend", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        error: "Terminal not found",
        source: "none",
      });

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("Error getting terminal output");
    });

    it("passes maxLines parameter", async () => {
      mockFrontendAPI.requestGetTerminalOutput.mockResolvedValue({
        output: "line 1",
        source: "terminal",
        isRunning: false,
      });

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
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

      const tool = getRegisteredTools(server.instance)["GetTerminalOutput"];
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("No output available yet");
    });
  });
});
