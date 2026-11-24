/**
 * Chat Area — renders the active chat tab and wires up the tab bar.
 *
 * Tab lifecycle (create, close, restore, labels) is managed by useChatTabs.
 * This component focuses on layout and connecting tabs to SessionPanel.
 */

import { useMemo, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  SessionPanel,
  SessionTabBar,
  getChatTabSessionId,
  isSessionChatTab,
} from "@/features/session";
import { useWorkingSessionIds } from "@/features/session/api/session.queries";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useUnreadStore, unreadActions } from "@/features/session/store/unreadStore";
import { WorkspaceStartState } from "@/features/session/ui/WorkspaceStartState";
import { workspaceStart } from "@/features/workspace/lib/startState";
import { localFolder } from "@/features/workspace/lib/reach";
import { useWorkspaceStartStore } from "@/features/workspace/store/workspaceStartStore";
import type { Workspace } from "@/shared/types";
import { useChatTabs } from "./useChatTabs";

interface ChatAreaProps {
  workspace: Workspace;
  onCreatePRHandlerChange: (handler: (() => void) | null) => void;
  onSendAgentMessageHandlerChange: Dispatch<
    SetStateAction<((text: string) => Promise<void>) | null>
  >;
}

export function ChatArea({
  workspace,
  onCreatePRHandlerChange,
  onSendAgentMessageHandlerChange,
}: ChatAreaProps) {
  const {
    tabs,
    activeTabId,
    activeTab,
    closedTabs,
    focusActiveTabKey,
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
  const tabSessionId = getChatTabSessionId(activeTab) || workspace.current_session_id;

  // The chat this workspace started with (while this client watched) opens
  // with the story of the start; no other chat does.
  const startedHere = useWorkspaceStartStore(
    (state) => !!tabSessionId && state.startedIn[workspace.id] === tabSessionId
  );

  // Per-tab working status: subscribes to each chat tab's session detail cache
  // so each tab's spinner reflects its own session's status (not the workspace's
  // single session_status which breaks with multiple tabs).
  const chatSessionIds = useMemo(
    () => tabs.filter(isSessionChatTab).map((tab) => tab.sessionId),
    [tabs]
  );
  const workingSessionIds = useWorkingSessionIds(chatSessionIds);

  useEffect(() => {
    if (tabSessionId) unreadActions.markRead(tabSessionId);
  }, [tabSessionId]);

  const unreadMap = useUnreadStore((s) => s.unreadSessionIds);
  const unreadSessionIds = useMemo(
    () => new Set(chatSessionIds.filter((sid) => unreadMap[sid])),
    [chatSessionIds, unreadMap]
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <SessionTabBar
        workspaceId={workspace.id}
        tabs={tabs}
        activeTabId={activeTabId}
        workingSessionIds={workingSessionIds}
        unreadSessionIds={unreadSessionIds}
        focusActiveTabKey={focusActiveTabKey}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        // No + in web-direct — session creation needs the Mac backend, and an
        // affordance that can only toast is clutter (handleTabAdd still guards
        // the Cmd+T path). None before the workspace has its first chat
        // either: it is still starting, or failed to, and the backend refuses.
        onTabAdd={isCloudDirectWebMode() || !tabSessionId ? undefined : handleTabAdd}
        onTabReorder={handleTabReorder}
        closedTabs={closedTabs}
        onTabRestore={handleTabRestore}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tabSessionId && (
          <SessionPanel
            key={tabSessionId}
            sessionId={tabSessionId}
            workspaceId={workspace.id}
            workspaceKind={workspace.kind}
            workspacePath={localFolder(workspace) ?? ""}
            workspaceRepoName={workspace.repo_name}
            workspaceParentBranch={workspace.git_target_branch}
            workspaceStart={startedHere ? workspaceStart(workspace) : undefined}
            workspaceDefaultBranch={workspace.git_default_branch}
            isFirstSession={workspace.latest_message_sent_at === null}
            embedded={true}
            initialModel={activeTab?.initialModel}
            onAgentHarnessChange={(agentHarness) =>
              activeTab && updateChatTabAgentHarness(activeTab.id, agentHarness)
            }
            onSessionStarted={() => activeTab && markChatTabStarted(activeTab.id)}
            onOpenNewTab={handleTabAdd}
            onCreatePR={(handler) => onCreatePRHandlerChange(() => handler)}
            onSendAgentMessage={(handler) => onSendAgentMessageHandlerChange(() => handler)}
          />
        )}

        {/* No chat yet: the workspace is starting, or it failed to start. */}
        {!tabSessionId && <WorkspaceStartState workspace={workspace} />}
      </div>
    </div>
  );
}
