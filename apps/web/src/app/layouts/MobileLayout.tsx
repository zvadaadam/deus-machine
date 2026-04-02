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
import { useFileChanges } from "@/features/workspace";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { WorkspaceHeader } from "@/features/workspace/ui/WorkspaceHeader";
import type { Workspace, PRStatus, GhCliStatus } from "@/shared/types";
import type { WorkspaceStatus } from "@shared/enums";
import type { NormalizedTask } from "@/features/workspace/api/workspace.service";
import { cn } from "@/shared/lib/utils";
import { ChatArea } from "./ChatArea";
import { MobileTabBar } from "./MobileTabBar";
import type { MobileTab } from "./MobileTabBar";
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
  prStatus,
  ghStatus,
  onCreatePR,
  onArchive,
  targetBranch,
  onTargetBranchChange,
}: MobileLayoutProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");

  // File changes -- always queried for the badge count on the code tab,
  // and used by ChangesDiffViewer when the code tab is active.
  const isReady = workspace.state === "ready";
  const { data: fileChangesData } = useFileChanges(
    isReady ? workspace.id : null,
    workspace.session_status,
    isWatched,
    workspace.state
  );
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);

  // Insert code review prompt into chat input and switch to chat tab
  const handleInsertReviewPrompt = useCallback(() => {
    workspaceChatPanelRef.current?.insertText(REVIEW_CODE);
    setActiveTab("chat");
  }, [workspaceChatPanelRef]);

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
        <MobilePRHeaderAction {...prBarProps} />
      </div>

      {/* PR status bar -- only shown when a PR exists, 32px */}
      <MobilePRStatusBar {...prBarProps} />

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

      {/* Bottom tab bar */}
      <MobileTabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        fileChangesCount={fileChanges.length}
      />
    </div>
  );
}
