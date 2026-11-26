/**
 * WorkspaceContentPane — owns the right-pane tab strip, keyboard shortcuts,
 * and active content view so tab/title churn never re-renders MainContent or ChatArea.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFileChanges, useWorkspaceTabsState } from "@/features/workspace";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { onLocalhost } from "@/features/workspace/lib/reach";
import {
  workspaceLayoutActions,
  type WorkspacePanelMode,
} from "@/features/workspace/store/workspaceLayoutStore";
import {
  DEFAULT_NEW_TAB,
  WorkspaceTabBar,
  workspaceTabDomId,
  workspaceTabPanelDomId,
  useWorkspaceTabShortcuts,
  isWorkspaceTabVisible,
  type ContentTab,
  type ContentTabVisibility,
} from "@/features/workspace-tabs";
import { cloudPreviewActions } from "@/features/browser/cloud/cloudPreviewStore";
import { useSettings } from "@/features/settings/api/settings.queries";
import { cn } from "@/shared/lib/utils";
import { track } from "@/platform/analytics";
import { native } from "@/platform/native";
import type { Workspace } from "@/shared/types";
import type { ProjectTask } from "@shared/types/project-environment";
import { ContentView } from "./ContentView";
import { WorkspacePanelButton } from "./WorkspacePanelButton";

function trackToolOpened(tool: ContentTab, workspaceId: string) {
  const tabEventMap: Partial<Record<ContentTab, () => void>> = {
    terminal: () => track("terminal_opened", { workspace_id: workspaceId }),
    browser: () => track("browser_opened", { workspace_id: workspaceId }),
    device: () => track("device_opened", { workspace_id: workspaceId }),
    changes: () => track("diff_viewed", { workspace_id: workspaceId }),
    files: () => track("files_opened", { workspace_id: workspaceId }),
  };
  tabEventMap[tool]?.();
}

interface WorkspaceContentPaneProps {
  workspace: Workspace;
  view: WorkspacePanelMode;
  onModeChange: (mode: WorkspacePanelMode) => void;
  visibility: ContentTabVisibility;
  isWatched: boolean;
  onReview: () => void;
  environmentTasks?: ProjectTask[];
  onRunTask?: (taskName: string) => void;
  prActions: ReactNode;
}

export function WorkspaceContentPane({
  workspace,
  view,
  onModeChange,
  visibility,
  isWatched,
  onReview,
  environmentTasks,
  onRunTask,
  prActions,
}: WorkspaceContentPaneProps) {
  const workspaceId = workspace.id;
  const isCloud = workspace.kind === "cloud";
  const panelVisible = view !== "chat";

  const {
    workspaceTabs,
    activeTabId,
    migratedActiveTool,
    selectTab,
    addNewTab,
    closeTab,
    reorderTabs,
  } = useWorkspaceTabsState(workspaceId);

  // Resolve any preserved v11 selected tool (e.g. Terminal or cloud Browser) once workspace kind is known.
  useEffect(() => {
    if (!migratedActiveTool) return;
    workspaceLayoutActions.resolveMigratedTool(workspaceId, { cloud: isCloud });
  }, [workspaceId, isCloud, migratedActiveTool]);

  const closeWithFocusRef = useRef<((tabId: string) => void) | null>(null);

  const experimentalSettings = useSettings().data;

  // Filter open tabs by current visibility gates
  const visibleWorkspaceTabs = useMemo(() => {
    const filtered = workspaceTabs.filter((tab) =>
      isWorkspaceTabVisible(tab, experimentalSettings, visibility)
    );
    return filtered.length > 0 ? filtered : [DEFAULT_NEW_TAB];
  }, [workspaceTabs, experimentalSettings, visibility]);

  const effectiveActiveTab = useMemo(
    () => visibleWorkspaceTabs.find((t) => t.id === activeTabId) ?? visibleWorkspaceTabs[0],
    [visibleWorkspaceTabs, activeTabId]
  );

  // Cloud Browser is a singleton preview; unmount its guest whenever no cloud browser tab is open.
  const hasCloudBrowserTab = isCloud && workspaceTabs.some((t) => t.kind === "browser");

  // Only poll file changes for the Changes tab badge when a Changes tab is actually visible.
  const hasChangesTab = visibleWorkspaceTabs.some((t) => t.kind === "changes");
  const isReady = workspace.state === "ready";
  const cloudGate = cloudGateStage(workspace);
  const { data: fileChangesData } = useFileChanges(
    panelVisible && isReady && !cloudGate && hasChangesTab ? workspace : null,
    isWatched
  );
  const fileChangesCount = fileChangesData?.files?.length ?? 0;

  const handleNewTabOpenTool = useCallback(
    (tool: ContentTab, replaceTabId: string) => {
      workspaceLayoutActions.openToolTab(workspaceId, tool, {
        replaceTabId,
        forceNew: tool === "terminal" || (!isCloud && tool === "browser"),
        cloud: isCloud,
        reveal: true,
      });
      trackToolOpened(tool, workspaceId);
    },
    [workspaceId, isCloud]
  );

  const handleNewTabOpenFile = useCallback(
    (path: string, replaceTabId: string) => {
      workspaceLayoutActions.openFileTab(workspaceId, path, {
        replaceTabId,
        reveal: true,
      });
      track("files_opened", { workspace_id: workspaceId });
    },
    [workspaceId]
  );

  const handleNewTabOpenUrl = useCallback(
    (url: string, replaceTabId: string) => {
      if (isCloud) {
        // Cloud workspaces preview sandbox ports via CloudPreviewPanel; external URLs open in host browser.
        const preview = onLocalhost(url);
        if (preview) {
          cloudPreviewActions.show(workspaceId, preview.port, preview.rest);
          workspaceLayoutActions.openToolTab(workspaceId, "browser", {
            replaceTabId,
            cloud: true,
            reveal: true,
          });
          track("browser_opened", { workspace_id: workspaceId });
          return;
        }
        void native.window.openExternal(url);
        return;
      }

      workspaceLayoutActions.openBrowserTab(workspaceId, url, {
        replaceTabId,
        reveal: true,
      });
      track("browser_opened", { workspace_id: workspaceId });
    },
    [workspaceId, isCloud]
  );

  const handleShortcutSelectTab = useCallback(
    (tabId: string) => {
      selectTab(tabId);
      if (view === "chat") onModeChange("split");
    },
    [selectTab, view, onModeChange]
  );

  // Pick the visible successor once so both active selection and keyboard focus restoration
  // land on the exact same tab even when hidden/gated tabs sit between visible tabs.
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const visibleIdx = visibleWorkspaceTabs.findIndex((t) => t.id === tabId);
      const nextVisibleId =
        visibleIdx !== -1
          ? (visibleWorkspaceTabs[visibleIdx + 1]?.id ?? visibleWorkspaceTabs[visibleIdx - 1]?.id)
          : undefined;
      closeTab(tabId, nextVisibleId);
    },
    [visibleWorkspaceTabs, closeTab]
  );

  const handleShortcutCloseTab = useCallback(
    (tabId: string) => {
      (closeWithFocusRef.current ?? handleCloseTab)(tabId);
    },
    [handleCloseTab]
  );

  useWorkspaceTabShortcuts({
    enabled: true,
    tabs: visibleWorkspaceTabs,
    activeTabId: effectiveActiveTab.id,
    onSelectTab: handleShortcutSelectTab,
    onCloseTab: handleShortcutCloseTab,
  });

  return (
    <div className={cn("flex h-full min-w-0 flex-col pr-2 pb-2", view === "content" && "pl-2")}>
      <div
        data-slot="workspace-tool-header"
        className="drag-region flex h-11 shrink-0 items-center gap-2 px-1"
      >
        {view === "content" && (
          <WorkspacePanelButton action="hide" onClick={() => onModeChange("chat")} />
        )}
        <WorkspaceTabBar
          tabs={visibleWorkspaceTabs}
          activeTabId={effectiveActiveTab.id}
          workspaceId={workspaceId}
          fileChangesCount={fileChangesCount}
          onTabSelect={selectTab}
          onTabClose={handleCloseTab}
          onTabAdd={addNewTab}
          onTabReorder={reorderTabs}
          closeWithFocusRef={closeWithFocusRef}
        />
        <div className="no-drag flex shrink-0 items-center gap-1.5">
          {prActions}
          <WorkspacePanelButton
            action={view === "content" ? "restore" : "expand"}
            onClick={() => onModeChange(view === "content" ? "split" : "content")}
          />
        </div>
      </div>
      <div
        id={workspaceTabPanelDomId(effectiveActiveTab.id)}
        role="tabpanel"
        aria-labelledby={workspaceTabDomId(effectiveActiveTab.id)}
        className="border-border-subtle bg-bg-elevated flex min-h-0 flex-1 overflow-hidden rounded-lg border"
      >
        <ContentView
          workspace={workspace}
          activeTab={effectiveActiveTab}
          hasCloudBrowserTab={hasCloudBrowserTab}
          panelVisible={panelVisible}
          isWatched={isWatched}
          onReview={onReview}
          visibility={visibility}
          environmentTasks={environmentTasks}
          onRunTask={onRunTask}
          onOpenTool={handleNewTabOpenTool}
          onOpenFile={handleNewTabOpenFile}
          onOpenUrl={handleNewTabOpenUrl}
        />
      </div>
    </div>
  );
}
