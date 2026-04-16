/**
 * Tool Registry Initialization
 *
 * Registers all tool renderers on app startup.
 * Import this file early in your app to ensure tools are registered.
 */

import { toolRegistry } from "./ToolRegistry";
import {
  DefaultToolRenderer,
  EditToolRenderer,
  WriteToolRenderer,
  BashToolRenderer,
  ReadToolRenderer,
  GrepToolRenderer,
  TodoWriteToolRenderer,
  GlobToolRenderer,
  BashOutputToolRenderer,
  MultiEditToolRenderer,
  WebFetchToolRenderer,
  WebSearchToolRenderer,
  KillShellToolRenderer,
  TaskToolRenderer,
  LSToolRenderer,
  // Deus MCP — Browser automation
  BrowserSnapshotToolRenderer,
  BrowserNavigateToolRenderer,
  BrowserNavigateBackToolRenderer,
  BrowserClickToolRenderer,
  BrowserTypeToolRenderer,
  BrowserPressKeyToolRenderer,
  BrowserHoverToolRenderer,
  BrowserSelectOptionToolRenderer,
  BrowserWaitForToolRenderer,
  BrowserEvaluateToolRenderer,
  BrowserConsoleMessagesToolRenderer,
  BrowserScreenshotToolRenderer,
  BrowserNetworkRequestsToolRenderer,
  BrowserScrollToolRenderer,
  // xcode-mcp — iOS Simulator
  XcodeMcpScreenshotToolRenderer,
  XcodeMcpTapToolRenderer,
  XcodeMcpTypeTextToolRenderer,
  XcodeMcpSwipeToolRenderer,
  XcodeMcpPressKeyToolRenderer,
  XcodeMcpBuildToolRenderer,
  XcodeMcpLaunchToolRenderer,
  XcodeMcpReadScreenToolRenderer,
  XcodeMcpWaitForToolRenderer,
  XcodeMcpGetProjectInfoToolRenderer,
  XcodeMcpRefreshDestinationsToolRenderer,
  // Tool discovery
  ToolSearchToolRenderer,
  // Plan mode lifecycle
  EnterPlanModeToolRenderer,
  ExitPlanModeToolRenderer,
  // Deus MCP — Workspace
  AskUserQuestionToolRenderer,
  GetWorkspaceDiffToolRenderer,
  DiffCommentToolRenderer,
  GetTerminalOutputToolRenderer,
  // Deus MCP — Recording
  RecordingStartToolRenderer,
  RecordingStopToolRenderer,
} from "./renderers";

// Idempotency guard - prevent double registration during HMR/dev
let __didRegisterTools = false;

/**
 * Initialize all tool renderers
 * Idempotent - safe to call multiple times
 */
export function registerAllTools() {
  if (__didRegisterTools) return;
  __didRegisterTools = true;

  // Set default renderer (fallback for unknown tools)
  toolRegistry.setDefault(DefaultToolRenderer);

  // Register specific tool renderers
  toolRegistry.register("Edit", EditToolRenderer);
  toolRegistry.register("Write", WriteToolRenderer);
  toolRegistry.register("Bash", BashToolRenderer);
  toolRegistry.register("Read", ReadToolRenderer);
  toolRegistry.register("Grep", GrepToolRenderer);
  toolRegistry.register("TodoWrite", TodoWriteToolRenderer);
  toolRegistry.register("Glob", GlobToolRenderer);
  toolRegistry.register("BashOutput", BashOutputToolRenderer);
  toolRegistry.register("MultiEdit", MultiEditToolRenderer);
  toolRegistry.register("WebFetch", WebFetchToolRenderer);
  toolRegistry.register("WebSearch", WebSearchToolRenderer);
  toolRegistry.register("KillShell", KillShellToolRenderer);
  toolRegistry.register("Task", TaskToolRenderer);
  toolRegistry.register("Agent", TaskToolRenderer); // Claude SDK "Agent" = same as "Task"
  toolRegistry.register("LS", LSToolRenderer);

  // Tool discovery
  toolRegistry.register("ToolSearch", ToolSearchToolRenderer);

  // Plan mode lifecycle tools
  toolRegistry.register("EnterPlanMode", EnterPlanModeToolRenderer);
  toolRegistry.register("ExitPlanMode", ExitPlanModeToolRenderer);

  // Deus MCP — Browser automation tools
  toolRegistry.register("BrowserSnapshot", BrowserSnapshotToolRenderer);
  toolRegistry.register("BrowserNavigate", BrowserNavigateToolRenderer);
  toolRegistry.register("BrowserNavigateBack", BrowserNavigateBackToolRenderer);
  toolRegistry.register("BrowserClick", BrowserClickToolRenderer);
  toolRegistry.register("BrowserType", BrowserTypeToolRenderer);
  toolRegistry.register("BrowserPressKey", BrowserPressKeyToolRenderer);
  toolRegistry.register("BrowserHover", BrowserHoverToolRenderer);
  toolRegistry.register("BrowserSelectOption", BrowserSelectOptionToolRenderer);
  toolRegistry.register("BrowserWaitFor", BrowserWaitForToolRenderer);
  toolRegistry.register("BrowserEvaluate", BrowserEvaluateToolRenderer);
  toolRegistry.register("BrowserConsoleMessages", BrowserConsoleMessagesToolRenderer);
  toolRegistry.register("BrowserScreenshot", BrowserScreenshotToolRenderer);
  toolRegistry.register("BrowserNetworkRequests", BrowserNetworkRequestsToolRenderer);
  toolRegistry.register("BrowserScroll", BrowserScrollToolRenderer);

  // Built-in Deus Simulator tools (agent-server MCP)
  toolRegistry.register("SimulatorScreenshot", XcodeMcpScreenshotToolRenderer);
  toolRegistry.register("SimulatorTap", XcodeMcpTapToolRenderer);
  toolRegistry.register("SimulatorTypeText", XcodeMcpTypeTextToolRenderer);
  toolRegistry.register("SimulatorSwipe", XcodeMcpSwipeToolRenderer);
  toolRegistry.register("SimulatorPressKey", XcodeMcpPressKeyToolRenderer);
  toolRegistry.register("SimulatorBuild", XcodeMcpBuildToolRenderer);
  toolRegistry.register("SimulatorLaunch", XcodeMcpLaunchToolRenderer);
  toolRegistry.register("SimulatorReadScreen", XcodeMcpReadScreenToolRenderer);
  toolRegistry.register("SimulatorWaitFor", XcodeMcpWaitForToolRenderer);
  toolRegistry.register("SimulatorGetProjectInfo", XcodeMcpGetProjectInfoToolRenderer);
  toolRegistry.register("SimulatorListDevices", XcodeMcpRefreshDestinationsToolRenderer);

  // Deus MCP server prefixed names (SDK uses mcp__deus__ToolName format)
  toolRegistry.register("mcp__deus__SimulatorScreenshot", XcodeMcpScreenshotToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorTap", XcodeMcpTapToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorTypeText", XcodeMcpTypeTextToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorSwipe", XcodeMcpSwipeToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorPressKey", XcodeMcpPressKeyToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorBuild", XcodeMcpBuildToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorLaunch", XcodeMcpLaunchToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorReadScreen", XcodeMcpReadScreenToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorWaitFor", XcodeMcpWaitForToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorGetProjectInfo", XcodeMcpGetProjectInfoToolRenderer);
  toolRegistry.register("mcp__deus__SimulatorListDevices", XcodeMcpRefreshDestinationsToolRenderer);

  // Old tool names from previous sessions (iOSSimulator* via old deus MCP)
  toolRegistry.register(
    "mcp__deus__iOSSimulatorListDevices",
    XcodeMcpRefreshDestinationsToolRenderer
  );
  toolRegistry.register("mcp__deus__iOSSimulatorStart", XcodeMcpScreenshotToolRenderer);
  toolRegistry.register("mcp__deus__iOSSimulatorScreenshot", XcodeMcpScreenshotToolRenderer);
  toolRegistry.register("mcp__deus__iOSSimulatorTap", XcodeMcpTapToolRenderer);
  toolRegistry.register("mcp__deus__iOSSimulatorSwipe", XcodeMcpSwipeToolRenderer);
  toolRegistry.register("mcp__deus__iOSSimulatorTypeText", XcodeMcpTypeTextToolRenderer);
  toolRegistry.register("mcp__deus__iOSSimulatorPressKey", XcodeMcpPressKeyToolRenderer);
  toolRegistry.register("mcp__deus__iOSSimulatorBuildAndRun", XcodeMcpBuildToolRenderer);

  // Backward compat: xcode-mcp tool names from existing session history
  toolRegistry.register("mcp__xcode-mcp__screenshot", XcodeMcpScreenshotToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__tap", XcodeMcpTapToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__type_text", XcodeMcpTypeTextToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__swipe", XcodeMcpSwipeToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__press_key", XcodeMcpPressKeyToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__build", XcodeMcpBuildToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__launch", XcodeMcpLaunchToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__read_screen", XcodeMcpReadScreenToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__wait_for", XcodeMcpWaitForToolRenderer);
  toolRegistry.register("mcp__xcode-mcp__get_project_info", XcodeMcpGetProjectInfoToolRenderer);
  toolRegistry.register(
    "mcp__xcode-mcp__refresh_destinations",
    XcodeMcpRefreshDestinationsToolRenderer
  );

  // Deus MCP — Workspace tools
  toolRegistry.register("AskUserQuestion", AskUserQuestionToolRenderer);
  toolRegistry.register("GetWorkspaceDiff", GetWorkspaceDiffToolRenderer);
  toolRegistry.register("DiffComment", DiffCommentToolRenderer);
  toolRegistry.register("GetTerminalOutput", GetTerminalOutputToolRenderer);

  // Deus MCP — Recording tools
  toolRegistry.register("recording_start", RecordingStartToolRenderer);
  toolRegistry.register("recording_stop", RecordingStopToolRenderer);
}

// Auto-initialize on import (idempotent)
registerAllTools();
