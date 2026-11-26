/**
 * MobileLayout -- single-panel mobile layout with bottom tab bar.
 *
 * Replaces the desktop ResizablePanelGroup on screens < 768px.
 * Chat opens first. The tab bar shows Code and any available Device panel.
 */

import { lazy, Suspense, useState, useCallback, useMemo } from "react";
import { localFolder } from "@/features/workspace/lib/reach";
import type { CloudPresence } from "@/features/workspace/lib/cloudPresence";
import type { Dispatch, SetStateAction } from "react";
import { REVIEW_CODE } from "@/features/session/lib/sessionPrompts";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { workspaceLayoutActions } from "@/features/workspace/store";
import { useFileChanges } from "@/features/workspace";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { CloudDevicePanel } from "@/features/device/cloud";
import { useDeviceActive } from "@/features/device/useDeviceActive";
import { isTabVisible, type ContentTabVisibility } from "@/features/workspace-tabs/registry";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import type { Workspace } from "@/shared/types";
import type { PRActionState } from "@/features/workspace/lib/prState";
import type { WorkspaceStatus } from "@shared/enums";
import type { ProjectTask } from "@shared/types/project-environment";
import { cn } from "@/shared/lib/utils";
import { failedToStart, hasCheckout } from "@/features/workspace/lib/startState";
import { ChatArea } from "./ChatArea";
import { MobileTabBar } from "./MobileTabBar";
import type { MobileTab } from "./MobileTabBar";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { MobilePRHeaderAction, MobilePRStatusBar } from "./MobilePRBar";

const DevicePanel = lazy(() => import("@/features/device/DevicePanel"));

interface MobileLayoutProps {
  visibility: ContentTabVisibility;
  workspace: Workspace;
  sendAgentMessageHandler: ((text: string) => Promise<void>) | null;
  handleSendAgentMessage: (text: string) => void;
  setCreatePRHandler: (handler: (() => void) | null) => void;
  setSendAgentMessageHandler: Dispatch<SetStateAction<((text: string) => Promise<void>) | null>>;
  isWatched: boolean;
  environmentTasks?: ProjectTask[];
  onRunTask?: (taskName: string) => void;
  onStatusChange?: (status: WorkspaceStatus) => void;
  /** Cloud presence, derived once by MainContent (same values as the desktop header). */
  cloudPresence?: CloudPresence;
  onCloudWake?: () => void;
  // PR actions
  prState: PRActionState;
  onCreatePR?: () => void;
  onArchive?: () => void;
  targetBranch: string;
  onTargetBranchChange: (branch: string) => void;
}

export function MobileLayout({
  workspace,
  sendAgentMessageHandler,
  handleSendAgentMessage,
  setCreatePRHandler,
  setSendAgentMessageHandler,
  isWatched,
  environmentTasks,
  visibility,
  onRunTask,
  onStatusChange,
  cloudPresence,
  onCloudWake,
  prState,
  onCreatePR,
  onArchive,
  targetBranch,
  onTargetBranchChange,
}: MobileLayoutProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");

  const chatOnly = isCloudDirectWebMode() || failedToStart(workspace);
  const showDevice = !chatOnly && isTabVisible("device", undefined, visibility);
  const cloudStage = cloudGateStage(workspace);
  const deviceLive = useDeviceActive(workspace.id);
  const tab = chatOnly || (activeTab === "device" && !showDevice) ? "chat" : activeTab;

  // File changes -- always queried for the badge count on the code tab,
  // and used by ChangesDiffViewer when the code tab is active.
  const { data: fileChangesData } = useFileChanges(chatOnly ? null : workspace, isWatched);
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);

  // Insert code review prompt into the active chat's composer and switch
  // to the chat tab. Writes directly to the composer store so the prompt
  // shows up regardless of whether the chat panel is mounted.
  const handleInsertReviewPrompt = useCallback(() => {
    const sid = workspaceLayoutActions.getLayout(workspace.id).activeChatTabSessionId;
    if (sid) sessionComposerActions.appendDraft(sid, REVIEW_CODE);
    setActiveTab("chat");
  }, [workspace.id]);

  // Shared PR bar props -- avoids repeating the same prop bag twice.
  const prBarProps = {
    state: prState,
    onCreatePR,
    onSendAgentMessage: sendAgentMessageHandler ? handleSendAgentMessage : undefined,
    onArchive,
    targetBranch,
    onTargetBranchChange,
    workspaceId: workspace.id,
    repoId: workspace.repository_id,
  };

  return (
    <div className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header row -- workspace title on left, compact Create PR pill on right */}
      <div className="flex min-w-0 flex-shrink-0 items-center justify-between pr-2">
        <WorkspaceHeader
          workspaceId={workspace.id}
          repositoryId={workspace.repository_id}
          title={workspace.title ?? undefined}
          repositoryName={workspace.repo_name}
          branch={workspace.git_branch ?? undefined}
          workspacePath={localFolder(workspace) ?? undefined}
          kind={workspace.kind}
          cloudPresence={cloudPresence}
          onCloudWake={onCloudWake}
          setupStatus={workspace.setup_status}
          setupError={workspace.error_message}
          onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
          workspaceStatus={workspace.status}
          onStatusChange={onStatusChange}
          tasks={environmentTasks}
          onRunTask={onRunTask}
          mobile
        />
        {/* PRs are Mac-side (gh + the worktree): web-direct has neither, so the
            Create PR sheet and the status bar don't mount. */}
        {!chatOnly && hasCheckout(workspace) && <MobilePRHeaderAction {...prBarProps} />}
      </div>

      {/* PR status bar -- only shown when a PR exists, 32px */}
      {!chatOnly && hasCheckout(workspace) && <MobilePRStatusBar {...prBarProps} />}

      {/* Content area -- both views always mounted, inactive hidden via display:none */}
      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", tab !== "chat" && "hidden")}
        id="mobile-panel-chat"
        role="tabpanel"
        aria-labelledby="mobile-tab-chat"
      >
        <ChatArea
          key={workspace.id}
          workspace={workspace}
          onCreatePRHandlerChange={setCreatePRHandler}
          onSendAgentMessageHandlerChange={setSendAgentMessageHandler}
        />
      </div>

      {/* Code panel — reuses ChangesView in compact mode (no file tree, keeps header) */}
      {!chatOnly && (
        <div
          className={cn("min-h-0 flex-1 overflow-hidden", tab !== "code" && "hidden")}
          id="mobile-panel-code"
          role="tabpanel"
          aria-labelledby="mobile-tab-code"
        >
          <ChangesView
            workspace={workspace}
            isWatched={isWatched}
            onReview={handleInsertReviewPrompt}
            compact
          />
        </div>
      )}

      {showDevice && (workspace.kind === "cloud" || tab === "device") && (
        <div
          className={cn("min-h-0 flex-1 overflow-hidden", tab !== "device" && "hidden")}
          id="mobile-panel-device"
          role="tabpanel"
          aria-labelledby="mobile-tab-device"
        >
          {workspace.kind !== "cloud" ? (
            <Suspense fallback={null}>
              <DevicePanel
                key={workspace.id}
                workspaceId={workspace.id}
                defaultSession={workspace.current_session_id ?? null}
              />
            </Suspense>
          ) : cloudStage ? (
            <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
          ) : (
            <CloudDevicePanel key={workspace.id} workspace={workspace} visible={tab === "device"} />
          )}
        </div>
      )}
      {!chatOnly && (
        <MobileTabBar
          activeTab={tab}
          onTabChange={setActiveTab}
          fileChangesCount={fileChanges.length}
          showDevice={showDevice}
          deviceLive={deviceLive}
        />
      )}
    </div>
  );
}
