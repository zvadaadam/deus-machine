export {
  DEFAULT_NEW_TAB,
  DEFAULT_NEW_TAB_ID,
  createTabId,
  createNewTab,
  createFileTab,
  createTerminalTab,
  createBrowserTabItem,
  createToolTab,
  basenameOfPath,
  type ContentTab,
  type WorkspaceTabKind,
  type WorkspaceTab,
} from "./types";

export {
  CONTENT_TABS,
  TAB_KIND_ICONS,
  tabsFor,
  isTabVisible,
  isWorkspaceTabVisible,
  getVisibleTools,
  getWorkspaceTabTitle,
  anyContentTabVisible,
  type ContentTabItem,
  type ContentTabVisibility,
} from "./registry";

export {
  parseOmniboxUrl,
  normalizeNavigationUrl,
  flattenFileTree,
  searchWorkspaceFiles,
} from "./lib/omnibox";

export { WorkspaceTabBar, workspaceTabDomId, workspaceTabPanelDomId } from "./ui/WorkspaceTabBar";
export { NewTabView } from "./ui/NewTabView";
export { FileTabView } from "./ui/FileTabView";
export { useWorkspaceTabShortcuts } from "./hooks/useWorkspaceTabShortcuts";
