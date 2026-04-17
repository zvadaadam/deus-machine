/**
 * Chat Area — renders the active chat tab and wires up the tab bar.
 *
 * Tab lifecycle (create, close, restore, labels) is managed by useChatTabs.
 * This component focuses on layout and connecting tabs to SessionPanel.
 */

import { useMemo, useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { useWorkingSessionIds } from "@/features/session/api/session.queries";
import { useUnreadStore, unreadActions } from "@/features/session/store/unreadStore";
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
    updateChatTabAgentHarness,
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
    () => tabs.filter((t) => t.data?.sessionId).map((t) => t.data!.sessionId!),
    [tabs]
  );
  const workingSessionIds = useWorkingSessionIds(chatSessionIds);

  // Mark non-active tab sessions as unread when they leave the working set.
  const activeSessionId = activeTab?.data?.sessionId;
  const prevWorkingRef = useRef(workingSessionIds);
  const prevWorkspaceRef = useRef(workspace.id);
  useEffect(() => {
    // Reset on workspace switch — don't compare across workspaces
    if (prevWorkspaceRef.current !== workspace.id) {
      prevWorkspaceRef.current = workspace.id;
      prevWorkingRef.current = workingSessionIds;
      return;
    }
    const prev = prevWorkingRef.current;
    prevWorkingRef.current = workingSessionIds;
    for (const sid of prev) {
      if (!workingSessionIds.has(sid) && sid !== activeSessionId) {
        unreadActions.markUnread(sid);
      }
    }
  }, [workingSessionIds, activeSessionId, workspace.id]);

  const unreadMap = useUnreadStore((s) => s.unreadSessionIds);
  const unreadSessionIds = useMemo(
    () => new Set(chatSessionIds.filter((sid) => unreadMap[sid])),
    [chatSessionIds, unreadMap]
  );

  // Wrap tab change to mark the newly-active session as read inline
  const handleTabChangeWithRead = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.data?.sessionId) {
        unreadActions.markRead(tab.data.sessionId);
      }
      handleTabChange(tabId);
    },
    [tabs, handleTabChange]
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        workingSessionIds={workingSessionIds}
        unreadSessionIds={unreadSessionIds}
        onTabChange={handleTabChangeWithRead}
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
            onAgentHarnessChange={(agentHarness) =>
              activeTab && updateChatTabAgentHarness(activeTab.id, agentHarness)
            }
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
