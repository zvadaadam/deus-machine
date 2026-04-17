/**
 * Tool header icons are intentionally muted.
 *
 * Color is reserved for higher-signal UI: file pills, diff counts,
 * status badges, and actual error states.
 */
export const TOOL_ICON_CLS = "h-3.5 w-3.5 flex-shrink-0";
export const TOOL_ICON_MUTED_CLS = "text-muted-foreground/55";

export const TOOL_COLORS: Record<string, string> = {
  // Information gathering
  Read: TOOL_ICON_MUTED_CLS,
  Grep: TOOL_ICON_MUTED_CLS,
  Glob: TOOL_ICON_MUTED_CLS,
  LS: TOOL_ICON_MUTED_CLS,
  BashOutput: TOOL_ICON_MUTED_CLS,

  // Creation
  Write: TOOL_ICON_MUTED_CLS,

  // Modification
  Edit: TOOL_ICON_MUTED_CLS,
  MultiEdit: TOOL_ICON_MUTED_CLS,

  // Execution
  Bash: TOOL_ICON_MUTED_CLS,
  Task: TOOL_ICON_MUTED_CLS,
  TodoWrite: TOOL_ICON_MUTED_CLS,

  // Destructive
  KillShell: TOOL_ICON_MUTED_CLS,

  // Tool discovery
  ToolSearch: TOOL_ICON_MUTED_CLS,

  // Network
  WebFetch: TOOL_ICON_MUTED_CLS,
  WebSearch: TOOL_ICON_MUTED_CLS,

  // Browser MCP
  BrowserSnapshot: TOOL_ICON_MUTED_CLS,
  BrowserNavigate: TOOL_ICON_MUTED_CLS,
  BrowserNavigateBack: TOOL_ICON_MUTED_CLS,
  BrowserClick: TOOL_ICON_MUTED_CLS,
  BrowserType: TOOL_ICON_MUTED_CLS,
  BrowserPressKey: TOOL_ICON_MUTED_CLS,
  BrowserHover: TOOL_ICON_MUTED_CLS,
  BrowserSelectOption: TOOL_ICON_MUTED_CLS,
  BrowserWaitFor: TOOL_ICON_MUTED_CLS,
  BrowserEvaluate: TOOL_ICON_MUTED_CLS,
  BrowserConsoleMessages: TOOL_ICON_MUTED_CLS,
  BrowserScreenshot: TOOL_ICON_MUTED_CLS,
  BrowserNetworkRequests: TOOL_ICON_MUTED_CLS,

  // Workspace MCP
  AskUserQuestion: TOOL_ICON_MUTED_CLS,
  GetWorkspaceDiff: TOOL_ICON_MUTED_CLS,
  DiffComment: TOOL_ICON_MUTED_CLS,
  GetTerminalOutput: TOOL_ICON_MUTED_CLS,

  // Recording MCP
  recording_start: TOOL_ICON_MUTED_CLS,
  recording_stop: TOOL_ICON_MUTED_CLS,
} as const;
