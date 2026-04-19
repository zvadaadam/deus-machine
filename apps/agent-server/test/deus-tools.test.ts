import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures mockFrontendAPI is available when the vi.mock factory runs (local mock variable name kept for brevity)
const { mockFrontendAPI } = vi.hoisted(() => ({
  mockFrontendAPI: {
    requestAskUserQuestion: vi.fn(),
    requestGetDiff: vi.fn(),
    requestDiffComment: vi.fn(),
    requestGetTerminalOutput: vi.fn(),
    requestSimulatorContext: vi.fn(),
    requestListApps: vi.fn(),
    requestLaunchApp: vi.fn(),
    requestStopApp: vi.fn(),
    requestReadAppSkill: vi.fn(),
  },
}));
vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: mockFrontendAPI,
}));

// Mock device-use/engine — the package is ESM-only, tests run in CJS context.
vi.mock("device-use/engine", () => ({
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

  it("registers all workspace + browser + simulator + apps + recording tools", () => {
    const tools = getRegisteredTools(server.instance);
    const toolNames = Object.keys(tools);
    expect(toolNames).toHaveLength(42);
    // Workspace tools
    expect(toolNames).toContain("AskUserQuestion");
    expect(toolNames).toContain("GetWorkspaceDiff");
    expect(toolNames).toContain("DiffComment");
    expect(toolNames).toContain("GetTerminalOutput");
    // AAP lifecycle tools
    expect(toolNames).toContain("list_apps");
    expect(toolNames).toContain("launch_app");
    expect(toolNames).toContain("stop_app");
    expect(toolNames).toContain("read_app_skill");
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
    expect(toolNames).toContain("SimulatorListApps");
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
  // AAP lifecycle tools — list_apps / launch_app / stop_app
  // ==========================================================================

  describe("list_apps", () => {
    it("passes the session's sessionId to the backend and returns JSON", async () => {
      mockFrontendAPI.requestListApps.mockResolvedValue({
        apps: [
          {
            id: "deus.mobile-use",
            name: "Mobile Use",
            description: "iOS",
            version: "0.2.0",
          },
        ],
        runningAppIds: [],
      });

      const tool = getRegisteredTools(server.instance)["list_apps"];
      // Claude sees an empty arg schema — no workspaceId required.
      const result = await tool.handler({});

      expect(mockFrontendAPI.requestListApps).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.apps[0].id).toBe("deus.mobile-use");
      expect(parsed.runningAppIds).toEqual([]);
    });

    it("returns AAP error text on failure (does NOT throw)", async () => {
      mockFrontendAPI.requestListApps.mockRejectedValue(new Error("backend gone"));

      const tool = getRegisteredTools(server.instance)["list_apps"];
      const result = await tool.handler({});

      expect(result.content[0].text).toMatch(/^AAP error: backend gone$/);
    });
  });

  describe("launch_app", () => {
    it("forwards appId + sessionId and renders a launch summary", async () => {
      mockFrontendAPI.requestLaunchApp.mockResolvedValue({
        runningAppId: "running-1",
        url: "http://127.0.0.1:45321/",
        bootstrap: "Call tools like snapshot + tap to drive the sim.",
      });

      const tool = getRegisteredTools(server.instance)["launch_app"];
      const result = await tool.handler({ appId: "deus.mobile-use" });

      expect(mockFrontendAPI.requestLaunchApp).toHaveBeenCalledWith({
        appId: "deus.mobile-use",
        sessionId: SESSION_ID,
      });
      expect(result.content[0].text).toContain("Launched deus.mobile-use");
      expect(result.content[0].text).toContain("runningAppId: running-1");
      expect(result.content[0].text).toContain("http://127.0.0.1:45321/");
      expect(result.content[0].text).toContain("App bootstrap hint");
      expect(result.content[0].text).toContain("Call tools like snapshot");
    });

    it("omits the bootstrap section when the response has none", async () => {
      mockFrontendAPI.requestLaunchApp.mockResolvedValue({
        runningAppId: "running-1",
        url: "http://127.0.0.1:45321/",
      });

      const tool = getRegisteredTools(server.instance)["launch_app"];
      const result = await tool.handler({ appId: "x.y" });

      expect(result.content[0].text).not.toContain("App bootstrap hint");
    });

    it("returns AAP error text on failure (does NOT throw)", async () => {
      mockFrontendAPI.requestLaunchApp.mockRejectedValue(
        new Error("failed to spawn — ENOENT device-use")
      );

      const tool = getRegisteredTools(server.instance)["launch_app"];
      const result = await tool.handler({ appId: "x.y" });

      expect(result.content[0].text).toMatch(/^AAP error: failed to spawn/);
    });
  });

  describe("stop_app", () => {
    it("forwards runningAppId and reports success", async () => {
      mockFrontendAPI.requestStopApp.mockResolvedValue({ success: true });

      const tool = getRegisteredTools(server.instance)["stop_app"];
      const result = await tool.handler({ runningAppId: "running-1" });

      expect(mockFrontendAPI.requestStopApp).toHaveBeenCalledWith({
        runningAppId: "running-1",
      });
      expect(result.content[0].text).toBe("Stopped runningAppId running-1.");
    });

    it("reports failure when the backend returns success=false", async () => {
      mockFrontendAPI.requestStopApp.mockResolvedValue({ success: false });

      const tool = getRegisteredTools(server.instance)["stop_app"];
      const result = await tool.handler({ runningAppId: "running-1" });

      expect(result.content[0].text).toBe("Failed to stop runningAppId running-1.");
    });

    it("returns AAP error text on failure (does NOT throw)", async () => {
      mockFrontendAPI.requestStopApp.mockRejectedValue(new Error("RPC timeout"));

      const tool = getRegisteredTools(server.instance)["stop_app"];
      const result = await tool.handler({ runningAppId: "running-1" });

      expect(result.content[0].text).toMatch(/^AAP error: RPC timeout$/);
    });
  });

  describe("read_app_skill", () => {
    it("forwards appId and returns skill content", async () => {
      mockFrontendAPI.requestReadAppSkill.mockResolvedValue({
        content: "# Mobile Use Skill\n\nUse `snapshot` then `tap`...",
      });

      const tool = getRegisteredTools(server.instance)["read_app_skill"];
      const result = await tool.handler({ appId: "deus.mobile-use" });

      expect(mockFrontendAPI.requestReadAppSkill).toHaveBeenCalledWith({
        appId: "deus.mobile-use",
      });
      expect(result.content[0].text).toContain("Mobile Use Skill");
    });

    it("renders a placeholder when the app declares no skills", async () => {
      mockFrontendAPI.requestReadAppSkill.mockResolvedValue({ content: "" });

      const tool = getRegisteredTools(server.instance)["read_app_skill"];
      const result = await tool.handler({ appId: "deus.empty" });

      expect(result.content[0].text).toBe("No skills declared for deus.empty.");
    });

    it("returns AAP error text on failure (does NOT throw)", async () => {
      mockFrontendAPI.requestReadAppSkill.mockRejectedValue(new Error("manifest gone"));

      const tool = getRegisteredTools(server.instance)["read_app_skill"];
      const result = await tool.handler({ appId: "deus.x" });

      expect(result.content[0].text).toMatch(/^AAP error: manifest gone$/);
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
