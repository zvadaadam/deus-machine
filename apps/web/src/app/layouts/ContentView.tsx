/**
 * Content View — clean polymorphic router for the active workspace tab.
 *
 * Tabs split cleanly into two lifecycle tiers:
 *   - Lazy: mounted only when active (`new-tab`, `changes`, `files`, `file`, `config`)
 *   - Persistent: always mounted, CSS-hidden when inactive (`terminal`, `browser`, `simulator`)
 *     so PTY sessions, Electron webviews, and simulator streams survive tab/workspace switches.
 *
 * Notice: Expand/Restore controls now live in the top WorkspaceTabBar rather
 * than being prop-drilled through every panel component.
 */

import { useLayoutEffect, useState } from "react";
import { match } from "ts-pattern";
import { TerminalHost } from "@/features/terminal";
import { BrowserHost } from "@/features/browser";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { CloudPreviewPanel } from "@/features/browser/ui/CloudPreviewPanel";
import { useCloudPreviewTemplate } from "@/features/browser/cloud/cloudPreviewStore";
import { CloudBrowserUnavailable } from "@/features/workspace/ui/CloudBrowserUnavailable";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { FilesView } from "@/features/workspace/ui/FilesView";
import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { SimulatorPanel } from "@/features/simulator";
import { CloudSimulatorPanel } from "@/features/simulator/cloud";
import {
  NewTabView,
  FileTabView,
  type ContentTab,
  type ContentTabVisibility,
  type WorkspaceTab,
} from "@/features/workspace-tabs";
import { cn } from "@/shared/lib/utils";
import type { Workspace } from "@/shared/types";
import type { ProjectTask } from "@shared/types/project-environment";

/**
 * The value while `active`; otherwise the last value seen while it was, frozen
 * (null before it ever was). Committed in a layout effect, not during render.
 */
function useLastWhile<T>(active: boolean, value: T, key: string): T | null {
  const [last, setLast] = useState<{ key: string; value: T } | null>(null);
  useLayoutEffect(() => {
    if (active) setLast((prev) => (prev?.key === key ? prev : { key, value }));
    // `key` stands for `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return active ? value : (last?.value ?? null);
}

interface ContentViewProps {
  workspace: Workspace;
  activeTab: WorkspaceTab;
  /** Whether the workspace currently has an open cloud browser tab (unmounts guest when closed). */
  hasCloudBrowserTab?: boolean;
  panelVisible?: boolean;
  /** Whether file watcher is active */
  isWatched?: boolean;
  /** Insert a code review prompt into the chat input */
  onReview?: () => void;
  /** The workspace's tab gates (`tabsFor`). */
  visibility: ContentTabVisibility;
  /** Workspace environment tasks for New Tab quick actions */
  environmentTasks?: ProjectTask[];
  onRunTask?: (taskName: string) => void;
  /** New Tab launch callbacks */
  onOpenTool: (tool: ContentTab, replaceTabId: string) => void;
  onOpenFile: (path: string, replaceTabId: string) => void;
  onOpenUrl: (url: string, replaceTabId: string) => void;
}

export function ContentView({
  workspace,
  activeTab,
  hasCloudBrowserTab = false,
  panelVisible = true,
  isWatched = false,
  onReview,
  visibility,
  environmentTasks,
  onRunTask,
  onOpenTool,
  onOpenFile,
  onOpenUrl,
}: ContentViewProps) {
  const cloud = workspace.kind === "cloud";
  const simulatorAvailable = visibility.simulatorAvailable === true;

  // Freeze local hosts on the last local workspace while viewing a cloud workspace
  // so local PTYs, webviews, and simulator sessions survive local ↔ cloud switches.
  const lastLocal = useLastWhile(
    !cloud,
    { id: workspace.id, path: workspace.workspace_path },
    `${workspace.id}\n${workspace.workspace_path}`
  );

  const cloudStage = cloudGateStage(workspace);
  const cloudServing = cloud && cloudStage === null;
  const cloudTerminalId = useLastWhile(cloudServing, workspace.id, workspace.id);
  const cloudPreviewTemplate = useCloudPreviewTemplate(cloud ? workspace.id : null);

  const isBrowserActive = activeTab.kind === "browser";
  const isTerminalActive = activeTab.kind === "terminal";
  const isSimulatorActive = activeTab.kind === "simulator";

  const lazyContent = match(activeTab)
    .with({ kind: "new-tab" }, (tab) => (
      <NewTabView
        key={`${workspace.id}:${tab.id}`}
        workspace={workspace}
        tabId={tab.id}
        visibility={visibility}
        isWatched={isWatched}
        environmentTasks={environmentTasks}
        onRunTask={onRunTask}
        onOpenTool={onOpenTool}
        onOpenFile={onOpenFile}
        onOpenUrl={onOpenUrl}
      />
    ))
    .with({ kind: "changes" }, () => (
      <ChangesView workspace={workspace} isWatched={isWatched} onReview={onReview} />
    ))
    .with({ kind: "files" }, () => <FilesView workspace={workspace} isWatched={isWatched} />)
    .with({ kind: "file" }, (tab) => (
      <FileTabView key={`${workspace.id}:${tab.id}`} workspace={workspace} filePath={tab.path} />
    ))
    .with({ kind: "config" }, () => <AgentConfigPanel workspace={workspace} />)
    .with({ kind: "browser" }, { kind: "terminal" }, { kind: "simulator" }, () => null)
    .exhaustive();

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Lazy tabs — mounted only when active */}
      {lazyContent}

      {/* Persistent host: Browser (local Electron webviews + cloud preview) */}
      <div
        className={cn(
          "relative h-full w-full min-w-0 overflow-hidden",
          !isBrowserActive && "pointer-events-none invisible absolute"
        )}
      >
        {lastLocal && (
          <div className={cn("h-full w-full", cloud && "hidden")}>
            <BrowserHost
              workspaceId={lastLocal.id}
              activeTabId={isBrowserActive && !cloud ? activeTab.id : null}
              panelVisible={panelVisible && isBrowserActive && !cloud}
            />
          </div>
        )}
        {cloud && (hasCloudBrowserTab || isBrowserActive) && (
          <div className="absolute inset-0 z-10">
            {cloudStage ? (
              <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
            ) : cloudPreviewTemplate ? (
              <CloudPreviewPanel
                key={workspace.id}
                workspace={workspace}
                template={cloudPreviewTemplate}
                visible={panelVisible && isBrowserActive}
              />
            ) : (
              <CloudBrowserUnavailable />
            )}
          </div>
        )}
      </div>

      {/* Persistent host: Terminal (local + cloud PTYs across visited workspaces) */}
      <div
        className={cn(
          "relative h-full w-full",
          !isTerminalActive && "pointer-events-none invisible absolute"
        )}
      >
        {cloudTerminalId && (
          <div className={cn("h-full w-full", !cloudServing && "hidden")}>
            <TerminalHost
              workspaceId={cloudTerminalId}
              workspacePath=""
              cloud
              activeTabId={isTerminalActive && cloudServing ? activeTab.id : null}
              panelVisible={panelVisible && isTerminalActive && cloudServing}
            />
          </div>
        )}
        {lastLocal && (
          <div className={cn("h-full w-full", cloud && "hidden")}>
            <TerminalHost
              workspaceId={lastLocal.id}
              workspacePath={lastLocal.path}
              activeTabId={isTerminalActive && !cloud ? activeTab.id : null}
              panelVisible={panelVisible && isTerminalActive && !cloud}
            />
          </div>
        )}
        {cloudStage && (
          <div className="absolute inset-0 z-10">
            <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
          </div>
        )}
      </div>

      {/* Persistent host: Simulator (local iOS simulator + cloud hosted device) */}
      {(simulatorAvailable || cloud) && (
        <div
          className={cn(
            "relative h-full w-full",
            !isSimulatorActive && "pointer-events-none invisible absolute"
          )}
        >
          {simulatorAvailable && lastLocal && (
            <div className={cn("h-full w-full", cloud && "hidden")}>
              <SimulatorPanel workspaceId={lastLocal.id} />
            </div>
          )}
          {cloud && (
            <div className="absolute inset-0 z-10">
              {cloudStage ? (
                <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
              ) : (
                <CloudSimulatorPanel
                  key={workspace.id}
                  workspace={workspace}
                  visible={panelVisible && isSimulatorActive}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
