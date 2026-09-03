/**
 * MobileLayout -- single-panel mobile layout with bottom tab bar.
 *
 * Replaces the desktop ResizablePanelGroup on screens < 768px.
 * Two views: Chat (full-width ChatArea) and Code (full-width ChangesDiffViewer).
 * Chat is the default -- "AI chat as a first-class citizen".
 */

import { useState, useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SessionPanelRef } from "@/features/session";
import { REVIEW_CODE } from "@/features/session/lib/sessionPrompts";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import { workspaceLayoutActions } from "@/features/workspace/store";
import { useFileChanges } from "@/features/workspace";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { CloudSimulatorPanel } from "@/features/simulator/cloud/CloudSimulatorPanel";
import { useCloudSimulatorStore } from "@/features/simulator/cloud/cloudSimulatorStore";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import type { Workspace, PRStatus, GhCliStatus } from "@/shared/types";
import type { WorkspaceStatus } from "@shared/enums";
import type { NormalizedTask } from "@/features/workspace/api/workspace.service";
import { cn } from "@/shared/lib/utils";
import { ChatArea } from "./ChatArea";
import { MobileTabBar } from "./MobileTabBar";
import type { MobileTab } from "./MobileTabBar";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { MobilePRHeaderAction, MobilePRStatusBar } from "./MobilePRBar";

interface MobileLayoutProps {
  workspace: Workspace;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  sendAgentMessageHandler: ((text: string) => Promise<void>) | null;
  handleSendAgentMessage: (text: string) => void;
  /** Pre-gated by caller: only passed when setup_status === "failed" */
  onRetrySetup?: () => void;
  /** Pre-gated by caller: only passed when setup_status === "failed" */
  onViewSetupLogs?: () => void;
  setCreatePRHandler: (handler: (() => void) | null) => void;
  setSendAgentMessageHandler: Dispatch<SetStateAction<((text: string) => Promise<void>) | null>>;
  isWatched: boolean;
  manifestTasks?: NormalizedTask[];
  hasManifest?: boolean;
  onRunTask?: (taskName: string) => void;
  onStatusChange?: (status: WorkspaceStatus) => void;
  /** Cloud presence, derived once by MainContent (same values as the desktop header). */
  cloudAsleep?: boolean;
  cloudWaking?: boolean;
  onCloudWake?: () => void;
  // PR actions
  prStatus: PRStatus | null;
  ghStatus?: GhCliStatus | null;
  onCreatePR?: () => void;
  onArchive?: () => void;
  targetBranch: string;
  onTargetBranchChange: (branch: string) => void;
}

export function MobileLayout({
  workspace,
  workspaceChatPanelRef,
  sendAgentMessageHandler,
  handleSendAgentMessage,
  onRetrySetup,
  onViewSetupLogs,
  setCreatePRHandler,
  setSendAgentMessageHandler,
  isWatched,
  manifestTasks,
  hasManifest,
  onRunTask,
  onStatusChange,
  cloudAsleep,
  cloudWaking,
  onCloudWake,
  prStatus,
  ghStatus,
  onCreatePR,
  onArchive,
  targetBranch,
  onTargetBranchChange,
}: MobileLayoutProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");

  // Web-direct is chat-only on mobile too: the Code tab's diff traffic reads
  // the Mac backend, which the direct lane doesn't have — so the tab bar and
  // Code panel don't mount and the diff query never fires.
  const chatOnly = isCloudDirectWebMode();

  // A cloud computer hosts a device in the platform — billable, so a phone
  // must be able to see and stop it. Web-direct has no Mac backend to relay
  // the device commands through, so it stays chat-only.
  const cloudSimulator = workspace.kind === "cloud" && !chatOnly;
  const cloudStage = cloudGateStage(workspace);
  const simulatorLive = useCloudSimulatorStore(
    (s) => s.byWorkspace[workspace.id]?.status === "ready"
  );

  // File changes -- always queried for the badge count on the code tab,
  // and used by ChangesDiffViewer when the code tab is active.
  const isReady = workspace.state === "ready";
  const { data: fileChangesData } = useFileChanges(
    !chatOnly && isReady ? workspace.id : null,
    workspace.session_status,
    isWatched,
    workspace.state
  );
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
    prStatus,
    ghStatus,
    onCreatePR,
    onSendAgentMessage: sendAgentMessageHandler ? handleSendAgentMessage : undefined,
    onArchive,
    targetBranch,
    onTargetBranchChange,
    workspaceId: workspace.id,
    repoId: workspace.repository_id,
  };

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden">
      {/* Header row -- workspace title on left, compact Create PR pill on right */}
      <div className="flex min-w-0 flex-shrink-0 items-center justify-between pr-2">
        <WorkspaceHeader
          title={workspace.title ?? undefined}
          repositoryName={workspace.repo_name}
          branch={workspace.git_branch ?? undefined}
          workspacePath={workspace.workspace_path}
          kind={workspace.kind}
          cloudAsleep={cloudAsleep}
          cloudWaking={cloudWaking}
          onCloudWake={onCloudWake}
          setupStatus={workspace.setup_status}
          setupError={workspace.error_message}
          onSendAgentMessage={sendAgentMessageHandler ? handleSendAgentMessage : undefined}
          onRetrySetup={onRetrySetup}
          onViewSetupLogs={onViewSetupLogs}
          workspaceStatus={workspace.status}
          onStatusChange={onStatusChange}
          tasks={manifestTasks}
          hasManifest={hasManifest}
          onRunTask={onRunTask}
          mobile
        />
        {/* PRs are Mac-side (gh + the worktree): web-direct has neither, so the
            Create PR sheet and the status bar don't mount. */}
        {!chatOnly && <MobilePRHeaderAction {...prBarProps} />}
      </div>

      {/* PR status bar -- only shown when a PR exists, 32px */}
      {!chatOnly && <MobilePRStatusBar {...prBarProps} />}

      {/* Content area -- both views always mounted, inactive hidden via display:none */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          activeTab !== "chat" && "hidden"
        )}
        id="mobile-panel-chat"
        role="tabpanel"
        aria-labelledby="mobile-tab-chat"
      >
        <ChatArea
          key={workspace.id}
          workspace={workspace}
          workspaceChatPanelRef={workspaceChatPanelRef}
          onCreatePRHandlerChange={setCreatePRHandler}
          onSendAgentMessageHandlerChange={setSendAgentMessageHandler}
        />
      </div>

      {/* Code panel — reuses ChangesView in compact mode (no file tree, keeps header) */}
      {!chatOnly && (
        <div
          className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "code" && "hidden")}
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

      {/* Hosted simulator — the same gate/panel pair the desktop Simulator tab
          renders; hidden (not unmounted) like the other panels. */}
      {cloudSimulator && (
        <div
          className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "simulator" && "hidden")}
          id="mobile-panel-simulator"
          role="tabpanel"
          aria-labelledby="mobile-tab-simulator"
        >
          {cloudStage ? (
            <CloudSandboxGate workspaceId={workspace.id} stage={cloudStage} />
          ) : (
            <CloudSimulatorPanel
              key={workspace.id}
              workspace={workspace}
              visible={activeTab === "simulator"}
            />
          )}
        </div>
      )}

      {/* Bottom tab bar — a one-tab bar is noise, so chat-only drops it */}
      {!chatOnly && (
        <MobileTabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          fileChangesCount={fileChanges.length}
          showSimulator={cloudSimulator}
          simulatorLive={simulatorLive}
        />
      )}
    </div>
  );
}
