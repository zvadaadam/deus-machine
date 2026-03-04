/**
 * Chat Area — renders the active chat tab and wires up the tab bar.
 *
 * Tab lifecycle (create, close, restore, labels) is managed by useChatTabs.
 * This component focuses on layout and connecting tabs to SessionPanel.
 */

import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { useWorkingSessionIds } from "@/features/session/api/session.queries";
import { WorkspaceEmptyState } from "@/features/session/ui/WorkspaceEmptyState";
import { MainContentTabBar } from "@/features/workspace";
import type { Workspace } from "@/shared/types";
import { useChatTabs } from "./useChatTabs";

interface ChatAreaProps {
  workspace: Workspace;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreatePRHandlerChange: (handler: (() => void) | null) => void;
  onSendAgentMessageHandlerChange: Dispatch<
    SetStateAction<((text: string) => Promise<void>) | null>
  >;
  onCollapseChatPanel?: () => void;
}

export function ChatArea({
  workspace,
  workspaceChatPanelRef,
  onCreatePRHandlerChange,
  onSendAgentMessageHandlerChange,
  onCollapseChatPanel,
}: ChatAreaProps) {
  const {
    tabs,
    activeTabId,
    activeTab,
    closedTabs,
    handleTabChange,
    handleTabClose,
    handleTabAdd,
    handleTabReorder,
    handleTabRestore,
    updateChatTabAgentType,
    markChatTabStarted,
  } = useChatTabs({
    workspaceId: workspace.id,
    activeSessionId: workspace.current_session_id,
  });

  // Resolve sessionId: tab's own session, falling back to workspace's active session
  const tabSessionId = activeTab?.data?.sessionId || workspace.current_session_id;

  // Per-tab working status: subscribes to each chat tab's session detail cache
  // so each tab's spinner reflects its own session's status (not the workspace's
  // single session_status which breaks with multiple tabs).
  const chatSessionIds = useMemo(
    () =>
      tabs
        .filter((t) => t.data?.sessionId)
        .map((t) => t.data!.sessionId!),
    [tabs]
  );
  const workingSessionIds = useWorkingSessionIds(chatSessionIds);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        workingSessionIds={workingSessionIds}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onTabAdd={handleTabAdd}
        onTabReorder={handleTabReorder}
        closedTabs={closedTabs}
        onTabRestore={handleTabRestore}
        onCollapseChatPanel={onCollapseChatPanel}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tabSessionId && (
          <SessionPanel
            key={tabSessionId}
            ref={workspaceChatPanelRef}
            sessionId={tabSessionId}
            workspaceId={workspace.id}
            workspacePath={workspace.workspace_path}
            workspaceRepoName={workspace.repo_name}
            workspaceParentBranch={workspace.git_target_branch}
            workspaceDefaultBranch={workspace.git_default_branch}
            isFirstSession={workspace.latest_message_sent_at === null}
            embedded={true}
            initialModel={activeTab?.data?.initialModel}
            onAgentTypeChange={(agentType) => activeTab && updateChatTabAgentType(activeTab.id, agentType)}
            onSessionStarted={() => activeTab && markChatTabStarted(activeTab.id)}
            onOpenNewTab={handleTabAdd}
            onCreatePR={(handler) => onCreatePRHandlerChange(() => handler)}
            onSendAgentMessage={(handler) => onSendAgentMessageHandlerChange(() => handler)}
          />
        )}

        {/* Workspace still initializing — show the same empty state with init progress */}
        {!tabSessionId && (
          <WorkspaceEmptyState
            repoName={workspace.repo_name}
            parentBranch={workspace.git_target_branch}
            isFirstSession={true}
            initializing={workspace.state === "initializing"}
            initStep={workspace.init_stage}
          />
        )}
      </div>
    </div>
  );
}
