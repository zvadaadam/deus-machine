/**
 * Content View — thin router for the active content tab.
 *
 * Each tab is either:
 *   - Lazy: mounted/unmounted on tab switch (Changes, Files, Config, Design)
 *   - Persistent: always mounted, hidden when inactive (Terminal, Browser, Simulator)
 *     These preserve native state (PTY sessions, WebView instances).
 *
 * Data fetching is owned by each tab component, not by this router.
 */

import { useLayoutEffect, useState } from "react";
import { TerminalPanel } from "@/features/terminal";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { CloudPreviewPanel } from "@/features/browser/ui/CloudPreviewPanel";
import { CloudBrowserUnavailable } from "@/features/workspace/ui/CloudBrowserUnavailable";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { FilesView } from "@/features/workspace/ui/FilesView";
import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { DesignPanel } from "@/features/workspace/ui/DesignPanel";
import { BrowserPanel } from "@/features/browser";
import { SimulatorPanel } from "@/features/simulator";
import { CloudSimulatorPanel } from "@/features/simulator/cloud";
import { AppsLauncher, useAppsLaunched, useAppsStopped } from "@/features/apps";
import { cn } from "@/shared/lib/utils";
import type { ContentTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";

interface ContentViewProps {
  workspace: Workspace;
  activeTab: ContentTab;
  /** Whether file watcher is active */
  isWatched?: boolean;
  /** Insert a code review prompt into the chat input */
  onReview?: () => void;
  simulatorAvailable: boolean;
  /** The workspace is a cloud computer: its device lives in the platform. */
  cloudSimulator: boolean;
}

export function ContentView({
  workspace,
  activeTab,
  isWatched = false,
  onReview,
  simulatorAvailable,
  cloudSimulator,
}: ContentViewProps) {
  // AAP lifecycle → Browser tabs: open on launch, close on stop/crash.
  // Both hooks ignore events targeting other workspaces and always mount
  // during a workspace session so a launch/stop completed while the user
  // is on a different content tab still takes effect.
  useAppsLaunched(workspace.id);
  useAppsStopped(workspace.id);

  // The terminal mounts for the LAST LOCAL workspace even while a cloud one
  // is selected — see the comment at the render site. A LOCAL selection uses
  // the live prop directly (no first-frame gap); the committed state only
  // serves CLOUD renders, so it may lag by an effect tick without being
  // user-visible. Updated in a layout effect, not during render — a discarded
  // render must not leak an uncommitted workspace into a later cloud mount.
  const [lastLocalTerminal, setLastLocalTerminal] = useState<{ id: string; path: string } | null>(
    null
  );
  useLayoutEffect(() => {
    if (workspace.kind !== "cloud") {
      setLastLocalTerminal((prev) =>
        prev?.id === workspace.id && prev.path === workspace.workspace_path
          ? prev
          : { id: workspace.id, path: workspace.workspace_path }
      );
    }
  }, [workspace.kind, workspace.id, workspace.workspace_path]);
  const terminalTarget =
    workspace.kind !== "cloud"
      ? { id: workspace.id, path: workspace.workspace_path }
      : lastLocalTerminal;

  // null when the cloud sidecar can serve (or the workspace is local); else the
  // stage the gate should show (provisioning / asleep / waking).
  const cloudStage = cloudGateStage(workspace);
  const cloudServing = workspace.kind === "cloud" && cloudStage === null;

  // Same freeze rule for the CLOUD panel, but keyed to the last SERVICEABLE
  // cloud workspace. Unmounting the shared cloud panel disposed live xterms
  // mid-frame (xterm's un-cancelable rAF work — the "reading 'dimensions'"
  // crash) and, on a visit to a paused/provisioning computer, would kill the
  // shells of OTHER still-awake cloud workspaces the panel caches. Gating on
  // "serving" means a non-serving computer never becomes the mounted id: its
  // shell never spawns against a down sidecar — the gate overlays instead — and
  // awake workspaces stay live underneath.
  const [lastCloudTerminal, setLastCloudTerminal] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (cloudServing) {
      setLastCloudTerminal((prev) => (prev === workspace.id ? prev : workspace.id));
    }
  }, [cloudServing, workspace.id]);
  const cloudTerminalId = cloudServing ? workspace.id : lastCloudTerminal;

  // The Browser previews a dev server at localhost:PORT — only reachable for a
  // LOCAL workspace. Freeze it on the last local workspace (like the terminal)
  // so a cloud visit doesn't unmount it mid-navigation and orphan the webview;
  // cloud gets the placeholder overlay instead.
  const [lastLocalBrowser, setLastLocalBrowser] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (workspace.kind !== "cloud") {
      setLastLocalBrowser((prev) => (prev === workspace.id ? prev : workspace.id));
    }
  }, [workspace.kind, workspace.id]);
  const browserTarget = workspace.kind !== "cloud" ? workspace.id : lastLocalBrowser;

  // The local simulator streams a Mac-hosted device — only a LOCAL workspace
  // has one. Same freeze as the Browser: a cloud visit must not unmount the
  // panel (its device claim and stream live in component state) and a cloud
  // id must never enter it. Cloud gets its own panel overlaid.
  const [lastLocalSimulator, setLastLocalSimulator] = useState<{
    id: string;
    path: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (workspace.kind !== "cloud") {
      setLastLocalSimulator((prev) =>
        prev?.id === workspace.id && prev.path === workspace.workspace_path
          ? prev
          : { id: workspace.id, path: workspace.workspace_path }
      );
    }
  }, [workspace.kind, workspace.id, workspace.workspace_path]);
  const simulatorTarget =
    workspace.kind !== "cloud"
      ? { id: workspace.id, path: workspace.workspace_path }
      : lastLocalSimulator;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Lazy tabs — mounted only when active */}
      {activeTab === "changes" && (
        <ChangesView workspace={workspace} isWatched={isWatched} onReview={onReview} />
      )}

      {activeTab === "files" && <FilesView workspace={workspace} isWatched={isWatched} />}

      {activeTab === "config" && <AgentConfigPanel workspace={workspace} />}

      {activeTab === "design" && <DesignPanel workspaceId={workspace.id} />}

      {activeTab === "apps" && <AppsLauncher workspaceId={workspace.id} />}

      {/* Persistent tabs — always mounted, hidden when inactive */}
      <div
        className={cn(
          "relative h-full w-full min-w-0 overflow-hidden",
          activeTab !== "browser" && "pointer-events-none invisible absolute"
        )}
      >
        {browserTarget && (
          <BrowserPanel
            workspaceId={browserTarget}
            panelVisible={activeTab === "browser" && workspace.kind !== "cloud"}
          />
        )}
        {workspace.kind === "cloud" && (
          <div className="absolute inset-0 z-10">
            {cloudStage ? (
              // Asleep / provisioning: nothing inside the sandbox can answer.
              <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
            ) : workspace.cloud_preview_template ? (
              // Keyed: switching between two cloud computers must not carry
              // the first one's port (and its draft) onto the second.
              <CloudPreviewPanel
                key={workspace.id}
                workspace={workspace}
                visible={activeTab === "browser"}
              />
            ) : (
              <CloudBrowserUnavailable />
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
          // channel and come back on the same pty-data/pty-exit events the
          // local terminal speaks — a separate panel instance so cloud ids
          // never mix into the frozen local panel below. Only ever a SERVING
          // workspace's id (see the freeze above), so the shell never spawns
          // against a down computer.
          <div className={cn("h-full w-full", workspace.kind !== "cloud" && "hidden")}>
            <TerminalPanel
              workspaceId={cloudTerminalId}
              workspacePath=""
              cloud
              panelVisible={activeTab === "terminal" && cloudServing}
            />
          </div>
        )}
        {terminalTarget && (
          // Mounted through cloud selections too (frozen on the last LOCAL
          // workspace): TerminalPanel keeps every visited workspace's xterm
          // buffers in component state, so unmounting it on a cloud visit
          // silently discarded scrollback that survives every local↔local
          // switch. Cloud ids never enter the panel — a local PTY at a cloud
          // row's path would be the masquerade the placeholder exists to
          // avoid.
          <div className={cn("h-full w-full", workspace.kind === "cloud" && "hidden")}>
            <TerminalPanel
              workspaceId={terminalTarget.id}
              workspacePath={terminalTarget.path}
              panelVisible={activeTab === "terminal" && workspace.kind !== "cloud"}
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
            <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
          </div>
        )}
      </div>

      {(simulatorAvailable || cloudSimulator) && (
        <div
          className={cn(
            "relative h-full w-full",
            activeTab !== "simulator" && "pointer-events-none invisible absolute"
          )}
        >
          {simulatorAvailable && simulatorTarget && (
            // Frozen on the last LOCAL workspace (see above); hidden, not
            // unmounted, under a cloud selection.
            <div className={cn("h-full w-full", workspace.kind === "cloud" && "hidden")}>
              <SimulatorPanel
                workspaceId={simulatorTarget.id}
                workspacePath={simulatorTarget.path}
              />
            </div>
          )}
          {workspace.kind === "cloud" && (
            <div className="absolute inset-0 z-10">
              {cloudStage ? (
                // Asleep / provisioning: the platform's device is reached
                // through the sidecar, which isn't up.
                <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
              ) : (
                // Keyed: two cloud computers must not share a panel instance
                // (its webview and screenshot bookkeeping are per device).
                <CloudSimulatorPanel
                  key={workspace.id}
                  workspace={workspace}
                  visible={activeTab === "simulator"}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
