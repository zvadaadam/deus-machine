/**
 * Content View — thin router for the active content tab.
 *
 * Each tab is either:
 *   - Lazy: mounted/unmounted on tab switch (Changes, Files, Config)
 *   - Persistent: always mounted, hidden when inactive (Terminal, Browser, Simulator)
 *     These preserve native state (PTY sessions, WebView instances).
 *
 * Data fetching is owned by each tab component, not by this router.
 */

import { useLayoutEffect, useState, type ReactNode } from "react";
import { TerminalPanel } from "@/features/terminal";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { CloudPreviewPanel } from "@/features/browser/ui/CloudPreviewPanel";
import { useCloudPreviewTemplate } from "@/features/browser/cloud/cloudPreviewStore";
import { CloudBrowserUnavailable } from "@/features/workspace/ui/CloudBrowserUnavailable";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { FilesView } from "@/features/workspace/ui/FilesView";
import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { BrowserPanel } from "@/features/browser";
import { SimulatorPanel } from "@/features/simulator";
import { CloudSimulatorPanel } from "@/features/simulator/cloud";
import { cn } from "@/shared/lib/utils";
import type { ContentTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";
import type { ContentTabVisibility } from "./content-tabs";

/**
 * The value while `active`; otherwise the last value seen while it was, frozen
 * (null before it ever was). Committed in a layout effect, not during render:
 * a discarded render must not leak an uncommitted value into a later frozen
 * mount. `key` names the value, so an equal one keeps the frozen object.
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
  activeTab: ContentTab;
  panelVisible?: boolean;
  toolbarAction?: ReactNode;
  /** Whether file watcher is active */
  isWatched?: boolean;
  /** Insert a code review prompt into the chat input */
  onReview?: () => void;
  /** The workspace's tab gates (`tabsFor`). */
  visibility: ContentTabVisibility;
}

export function ContentView({
  workspace,
  activeTab,
  panelVisible = true,
  toolbarAction,
  isWatched = false,
  onReview,
  visibility,
}: ContentViewProps) {
  const cloud = workspace.kind === "cloud";
  const simulatorAvailable = visibility.simulatorAvailable === true;
  // This computer's Terminal, Browser and Simulator panels stay mounted on the
  // LAST LOCAL workspace while a cloud one is selected (hidden, not unmounted):
  // they keep every visited workspace's xterm buffers, webviews and device
  // claim in component state, so unmounting on a cloud visit lost scrollback
  // and orphaned a webview mid-navigation. A cloud id never enters them — a
  // local PTY or simulator at a cloud row's path would be a masquerade. The
  // cloud panels are overlaid instead.
  const lastLocal = useLastWhile(
    !cloud,
    { id: workspace.id, path: workspace.workspace_path },
    `${workspace.id}\n${workspace.workspace_path}`
  );

  // null when the cloud sidecar can serve (or the workspace is local); else the
  // stage the gate should show (provisioning / asleep / waking).
  const cloudStage = cloudGateStage(workspace);
  const cloudServing = cloud && cloudStage === null;

  // Same freeze rule for the CLOUD terminal, but keyed to the last SERVICEABLE
  // cloud workspace. Unmounting the shared cloud panel disposed live xterms
  // mid-frame (xterm's un-cancelable rAF work — the "reading 'dimensions'"
  // crash) and, on a visit to a paused/provisioning computer, would kill the
  // shells of OTHER still-awake cloud workspaces the panel caches. Gating on
  // "serving" means a non-serving computer never becomes the mounted id: its
  // shell never spawns against a down sidecar — the gate overlays instead — and
  // awake workspaces stay live underneath.
  const cloudTerminalId = useLastWhile(cloudServing, workspace.id, workspace.id);

  // The computer's host template: in memory, seeded once, live on `cloudPreviewChanges`.
  const cloudPreviewTemplate = useCloudPreviewTemplate(cloud ? workspace.id : null);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Lazy tabs — mounted only when active */}
      {activeTab === "changes" && (
        <ChangesView
          toolbarAction={toolbarAction}
          workspace={workspace}
          isWatched={isWatched}
          onReview={onReview}
        />
      )}

      {activeTab === "files" && (
        <FilesView toolbarAction={toolbarAction} workspace={workspace} isWatched={isWatched} />
      )}

      {activeTab === "config" && (
        <AgentConfigPanel toolbarAction={toolbarAction} workspace={workspace} />
      )}

      {/* Persistent tabs — always mounted, hidden when inactive */}
      <div
        className={cn(
          "relative h-full w-full min-w-0 overflow-hidden",
          activeTab !== "browser" && "pointer-events-none invisible absolute"
        )}
      >
        {lastLocal && (
          <div className={cn("h-full w-full", cloud && "hidden")}>
            <BrowserPanel
              toolbarAction={toolbarAction}
              workspaceId={lastLocal.id}
              panelVisible={panelVisible && activeTab === "browser" && !cloud}
            />
          </div>
        )}
        {cloud && (
          <div className="absolute inset-0 z-10">
            {cloudStage ? (
              // Asleep / provisioning: nothing inside the sandbox can answer.
              <CloudSandboxGate
                toolbarAction={toolbarAction}
                workspaceId={workspace.id}
                stage={cloudStage}
              />
            ) : cloudPreviewTemplate ? (
              // Keyed: switching between two cloud computers must not carry
              // the first one's port (and its draft) onto the second.
              <CloudPreviewPanel
                toolbarAction={toolbarAction}
                key={workspace.id}
                workspace={workspace}
                template={cloudPreviewTemplate}
                visible={panelVisible && activeTab === "browser"}
              />
            ) : (
              <CloudBrowserUnavailable toolbarAction={toolbarAction} />
            )}
          </div>
        )}
      </div>

      <div
        className={cn(
          "relative h-full w-full",
          activeTab !== "terminal" && "pointer-events-none invisible absolute"
        )}
      >
        {cloudTerminalId && (
          // The REAL remote shell: pty frames ride the sidecar session
          // channel and come back on the same `terminalOutput` events the
          // local terminal speaks — a separate panel instance so cloud ids
          // never mix into the frozen local panel below. Only ever a SERVING
          // workspace's id (see the freeze above), so the shell never spawns
          // against a down computer.
          <div className={cn("h-full w-full", !cloudServing && "hidden")}>
            <TerminalPanel
              toolbarAction={toolbarAction}
              workspaceId={cloudTerminalId}
              workspacePath=""
              cloud
              panelVisible={panelVisible && activeTab === "terminal" && cloudServing}
            />
          </div>
        )}
        {lastLocal && (
          // Mounted through cloud selections too (frozen on the last LOCAL
          // workspace): TerminalPanel keeps every visited workspace's xterm
          // buffers in component state, so unmounting it on a cloud visit
          // silently discarded scrollback that survives every local↔local
          // switch. Cloud ids never enter the panel — a local PTY at a cloud
          // row's path would be the masquerade the placeholder exists to
          // avoid.
          <div className={cn("h-full w-full", cloud && "hidden")}>
            <TerminalPanel
              toolbarAction={toolbarAction}
              workspaceId={lastLocal.id}
              workspacePath={lastLocal.path}
              panelVisible={panelVisible && activeTab === "terminal" && !cloud}
            />
          </div>
        )}
        {cloudStage && (
          // Provisioning/asleep/waking: overlay the gate over the frozen cloud
          // panel. Because cloudTerminalId only tracks a SERVING workspace, the
          // non-serving computer never mounts a shell here (no dead "press
          // Enter" corpse / WebSocket error), and any other awake workspace's
          // shells stay live underneath the overlay.
          <div className="absolute inset-0 z-10">
            <CloudSandboxGate
              toolbarAction={toolbarAction}
              workspaceId={workspace.id}
              stage={cloudStage}
            />
          </div>
        )}
      </div>

      {(simulatorAvailable || cloud) && (
        <div
          className={cn(
            "relative h-full w-full",
            activeTab !== "simulator" && "pointer-events-none invisible absolute"
          )}
        >
          {simulatorAvailable && lastLocal && (
            // Frozen on the last LOCAL workspace (see above); hidden, not
            // unmounted, under a cloud selection.
            <div className={cn("h-full w-full", cloud && "hidden")}>
              <SimulatorPanel toolbarAction={toolbarAction} workspaceId={lastLocal.id} />
            </div>
          )}
          {cloud && (
            <div className="absolute inset-0 z-10">
              {cloudStage ? (
                // Asleep / provisioning: the platform's device is reached
                // through the sidecar, which isn't up.
                <CloudSandboxGate
                  toolbarAction={toolbarAction}
                  workspaceId={workspace.id}
                  stage={cloudStage}
                />
              ) : (
                // Keyed: two cloud computers must not share a panel instance
                // (its webview and screenshot bookkeeping are per device).
                <CloudSimulatorPanel
                  toolbarAction={toolbarAction}
                  key={workspace.id}
                  workspace={workspace}
                  visible={panelVisible && activeTab === "simulator"}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
