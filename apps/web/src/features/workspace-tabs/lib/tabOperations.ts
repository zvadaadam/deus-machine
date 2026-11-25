/**
 * Pure, immutable state transitions for the right-side workspace tab list.
 *
 * Keeping all tab-list math here (zero Zustand / DOM / webview side effects)
 * makes every transition trivial to reason about, compose, and test.
 */

import {
  DEFAULT_NEW_TAB_ID,
  createBrowserTabItem,
  createFileTab,
  createNewTab,
  createTerminalTab,
  createToolTab,
  type ContentTab,
  type WorkspaceTab,
} from "../types";

export interface TabListState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}

export interface TabMutationResult extends TabListState {
  /** ID of the tab created or focused by the operation. */
  tabId: string;
}

export interface CloseTabResult extends TabListState {
  /** The tab that was removed (for caller-side resource disposal), or null. */
  closedTab: WorkspaceTab | null;
}

function isVirtualDefaultTab(tabs: WorkspaceTab[], tabId?: string): boolean {
  return tabs.length === 0 && (tabId === undefined || tabId === DEFAULT_NEW_TAB_ID);
}

/**
 * Insert a new tab at the end, or replace `replaceTabId` in-place ONLY when
 * `replaceTabId` refers to an empty `new-tab` launcher. Restricting replacement
 * to launcher tabs guarantees callers can never silently overwrite a live
 * browser/terminal tab and bypass resource disposal.
 */
function insertOrReplaceLauncher(
  tabs: WorkspaceTab[],
  newTab: WorkspaceTab,
  replaceTabId?: string
): WorkspaceTab[] {
  if (isVirtualDefaultTab(tabs, replaceTabId)) {
    return [newTab];
  }
  if (replaceTabId) {
    const idx = tabs.findIndex((t) => t.id === replaceTabId);
    if (idx !== -1 && tabs[idx].kind === "new-tab") {
      const next = [...tabs];
      next[idx] = newTab;
      return next;
    }
  }
  return [...tabs, newTab];
}

/** Drop an empty `new-tab` launcher when focusing an already-open deduplicated tab. */
function dropLauncherIfEmpty(tabs: WorkspaceTab[], replaceTabId?: string): WorkspaceTab[] {
  if (!replaceTabId) return tabs;
  const target = tabs.find((t) => t.id === replaceTabId);
  if (!target || target.kind !== "new-tab") return tabs;
  const filtered = tabs.filter((t) => t.id !== replaceTabId);
  return filtered.length > 0 ? filtered : tabs;
}

export function addNewTabState(state: TabListState): TabMutationResult {
  const baseTabs = state.tabs.length === 0 ? [createNewTab()] : state.tabs;
  const nextTab = createNewTab();
  return {
    tabs: [...baseTabs, nextTab],
    activeTabId: nextTab.id,
    tabId: nextTab.id,
  };
}

export function closeTabState(
  state: TabListState,
  tabId: string,
  nextActiveTabId?: string
): CloseTabResult {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) {
    return { ...state, closedTab: null };
  }

  const closedTab = state.tabs[idx];
  const remaining = state.tabs.filter((t) => t.id !== tabId);

  if (remaining.length === 0) {
    const fresh = createNewTab();
    return {
      tabs: [fresh],
      activeTabId: fresh.id,
      closedTab,
    };
  }

  let activeTabId = state.activeTabId;
  if (state.activeTabId === tabId) {
    activeTabId =
      nextActiveTabId && remaining.some((t) => t.id === nextActiveTabId)
        ? nextActiveTabId
        : remaining[Math.min(idx, remaining.length - 1)].id;
  }

  return {
    tabs: remaining,
    activeTabId,
    closedTab,
  };
}

/**
 * Reorder tabs against the FULL tab list by `(draggedId, targetId)`.
 * Hidden/gated tabs that are filtered out of the rendered strip remain
 * preserved in the array rather than being dropped.
 */
export function reorderTabState(
  tabs: WorkspaceTab[],
  draggedId: string,
  targetId: string
): WorkspaceTab[] | null {
  if (draggedId === targetId) return null;
  const fromIdx = tabs.findIndex((t) => t.id === draggedId);
  const toIdx = tabs.findIndex((t) => t.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return null;

  const next = [...tabs];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

export function updateTabState<K extends WorkspaceTab["kind"]>(
  tabs: WorkspaceTab[],
  tabId: string,
  kind: K,
  updater: (tab: Extract<WorkspaceTab, { kind: K }>) => Extract<WorkspaceTab, { kind: K }>
): WorkspaceTab[] | null {
  let changed = false;
  const nextTabs = tabs.map((tab) => {
    if (tab.id !== tabId || tab.kind !== kind) return tab;
    const updated = updater(tab as Extract<WorkspaceTab, { kind: K }>);
    if (updated !== tab) changed = true;
    return updated;
  });
  return changed ? nextTabs : null;
}

export function openTerminalTabState(
  state: TabListState,
  title: string,
  replaceTabId?: string
): TabMutationResult {
  const newTab = createTerminalTab(title);
  return {
    tabs: insertOrReplaceLauncher(state.tabs, newTab, replaceTabId),
    activeTabId: newTab.id,
    tabId: newTab.id,
  };
}

export function openBrowserTabState(
  state: TabListState,
  workspaceId: string,
  url: string,
  options?: { background?: boolean; replaceTabId?: string; cloud?: boolean }
): TabMutationResult {
  // Cloud workspaces share one sandbox preview guest — treat cloud Browser as a singleton.
  if (options?.cloud) {
    const existing = state.tabs.find((t) => t.kind === "browser");
    if (existing) {
      const cleaned = dropLauncherIfEmpty(state.tabs, options.replaceTabId);
      const ensuredCloud = cleaned.map((t) =>
        t.id === existing.id && t.kind === "browser" && !t.cloud ? { ...t, cloud: true } : t
      );
      return {
        tabs: ensuredCloud,
        activeTabId: options.background ? state.activeTabId : existing.id,
        tabId: existing.id,
      };
    }
  }

  const newTab = createBrowserTabItem(workspaceId, url, { cloud: options?.cloud });
  const replaceId = options?.background ? undefined : options?.replaceTabId;
  const tabs = insertOrReplaceLauncher(state.tabs, newTab, replaceId);
  return {
    tabs,
    activeTabId: options?.background ? state.activeTabId : newTab.id,
    tabId: newTab.id,
  };
}

export function openFileTabState(
  state: TabListState,
  normalizedPath: string,
  replaceTabId?: string
): TabMutationResult {
  const existing = state.tabs.find((t) => t.kind === "file" && t.path === normalizedPath);
  if (existing) {
    return {
      tabs: dropLauncherIfEmpty(state.tabs, replaceTabId),
      activeTabId: existing.id,
      tabId: existing.id,
    };
  }

  const newTab = createFileTab(normalizedPath);
  return {
    tabs: insertOrReplaceLauncher(state.tabs, newTab, replaceTabId),
    activeTabId: newTab.id,
    tabId: newTab.id,
  };
}

export function openToolTabState(
  state: TabListState,
  workspaceId: string,
  kind: ContentTab,
  options: {
    forceNew?: boolean;
    replaceTabId?: string;
    nextTerminalNum: number;
    cloud?: boolean;
  }
): TabMutationResult & { consumedTerminalNum: boolean } {
  if (kind === "terminal") {
    if (!options.forceNew) {
      const existing = state.tabs.find((t) => t.kind === "terminal");
      if (existing) {
        return {
          tabs: dropLauncherIfEmpty(state.tabs, options.replaceTabId),
          activeTabId: existing.id,
          tabId: existing.id,
          consumedTerminalNum: false,
        };
      }
    }
    const res = openTerminalTabState(
      state,
      `Terminal ${options.nextTerminalNum}`,
      options.replaceTabId
    );
    return { ...res, consumedTerminalNum: true };
  }

  if (kind === "browser") {
    // Cloud browser is always singleton; local browser respects `forceNew`.
    if (options.cloud || !options.forceNew) {
      const existing = state.tabs.find((t) => t.kind === "browser");
      if (existing) {
        const cleaned = dropLauncherIfEmpty(state.tabs, options.replaceTabId);
        const ensuredCloud = options.cloud
          ? cleaned.map((t) =>
              t.id === existing.id && t.kind === "browser" && !t.cloud ? { ...t, cloud: true } : t
            )
          : cleaned;
        return {
          tabs: ensuredCloud,
          activeTabId: existing.id,
          tabId: existing.id,
          consumedTerminalNum: false,
        };
      }
    }
    const res = openBrowserTabState(state, workspaceId, "", {
      replaceTabId: options.replaceTabId,
      cloud: options.cloud,
    });
    return { ...res, consumedTerminalNum: false };
  }

  // Singleton tools: changes, files, simulator, config
  const existing = state.tabs.find((t) => t.kind === kind);
  if (existing) {
    return {
      tabs: dropLauncherIfEmpty(state.tabs, options.replaceTabId),
      activeTabId: existing.id,
      tabId: existing.id,
      consumedTerminalNum: false,
    };
  }

  const active = state.tabs.find((t) => t.id === state.activeTabId);
  const replaceId = options.replaceTabId ?? (active?.kind === "new-tab" ? active.id : undefined);
  const newTab = createToolTab(kind, workspaceId, { cloud: options.cloud });
  return {
    tabs: insertOrReplaceLauncher(state.tabs, newTab, replaceId),
    activeTabId: newTab.id,
    tabId: newTab.id,
    consumedTerminalNum: false,
  };
}
