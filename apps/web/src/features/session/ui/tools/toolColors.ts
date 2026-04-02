/**
 * Semantic icon colors by tool action type.
 *
 * Read/search tools → info (violet)
 * Write/create tools → success (green)
 * Edit/modify tools → warning (amber)
 * Execute/run tools → primary (copper)
 * Destructive tools → destructive (red)
 */
export const TOOL_COLORS: Record<string, string> = {
  // Information gathering
  Read: "text-info",
  Grep: "text-info",
  Glob: "text-info",
  LS: "text-info",
  BashOutput: "text-info",

  // Creation
  Write: "text-success",

  // Modification
  Edit: "text-warning",
  MultiEdit: "text-warning",

  // Execution
  Bash: "text-primary",
  Task: "text-primary",
  TodoWrite: "text-primary",

  // Destructive
  KillShell: "text-destructive",

  // Network
  WebFetch: "text-info",
  WebSearch: "text-info",

  // Browser MCP
  BrowserSnapshot: "text-info",
  BrowserNavigate: "text-primary",
  BrowserNavigateBack: "text-primary",
  BrowserClick: "text-warning",
  BrowserType: "text-warning",
  BrowserPressKey: "text-warning",
  BrowserHover: "text-info",
  BrowserSelectOption: "text-warning",
  BrowserWaitFor: "text-info",
  BrowserEvaluate: "text-primary",
  BrowserConsoleMessages: "text-info",
  BrowserScreenshot: "text-info",
  BrowserNetworkRequests: "text-info",

  // Workspace MCP
  AskUserQuestion: "text-primary",
  GetWorkspaceDiff: "text-info",
  DiffComment: "text-warning",
  GetTerminalOutput: "text-info",

  // Recording MCP
  recording_start: "text-muted-foreground",
  recording_stop: "text-primary",
} as const;

/** Standard icon sizing for tool headers */
export const TOOL_ICON_CLS = "h-3.5 w-3.5 flex-shrink-0";
