/**
 * MobileLayout -- single-panel mobile layout with bottom tab bar.
 *
 * Replaces the desktop ResizablePanelGroup on screens < 768px.
 * Two views: Chat (full-width ChatArea) and Code (full-width AllFilesDiffViewer).
 * Chat is the default -- "AI chat as a first-class citizen".
 */

import { useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SessionPanelRef } from "@/features/session";
import { useFileChanges } from "@/features/workspace";
import { AllFilesDiffViewer } from "@/features/workspace/ui/AllFilesDiffViewer";
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
  // and used by AllFilesDiffViewer when the code tab is active.
  const isReady = workspace.state === "ready";
  const { data: fileChangesData } = useFileChanges(
    isReady ? workspace.id : null,
    workspace.session_status,
    isWatched,
    workspace.state
  );
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);

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
      <div className="flex flex-shrink-0 items-center justify-between pr-2">
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

      {/* Code panel -- absolute positioning gives AllFilesDiffViewer's h-full a proper
          height context (h-full doesn't resolve inside flex-grown parents). */}
      <div
        className={cn("relative min-h-0 flex-1", activeTab !== "code" && "hidden")}
        id="mobile-panel-code"
        role="tabpanel"
        aria-labelledby="mobile-tab-code"
      >
        {fileChanges.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-text-muted text-sm">No file changes yet</p>
          </div>
        ) : (
          <div className="absolute inset-0 overflow-x-hidden overflow-y-auto px-2 pt-2">
            <AllFilesDiffViewer workspaceId={workspace.id} fileChanges={fileChanges} hideHeader />
          </div>
        )}
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
