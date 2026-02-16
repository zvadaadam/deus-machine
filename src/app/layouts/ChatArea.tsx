/**
 * Chat Area — renders the active chat/file tab and wires up the tab bar.
 *
 * Tab lifecycle (create, close, restore, labels) is managed by useChatTabs.
 * This component focuses on rendering and exposing openFileTab via ref.
 */

import { forwardRef, useImperativeHandle } from "react";
import type { Dispatch, SetStateAction } from "react";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { MainContentTabBar } from "@/features/workspace";
import { FileViewer } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import { useChatTabs } from "./useChatTabs";

/** Imperative methods exposed to parent via ref */
export interface ChatAreaRef {
  openFileTab: (filePath: string) => void;
}

interface ChatAreaProps {
  workspace: Workspace;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreatePRHandlerChange: (handler: (() => void) | null) => void;
  onSendAgentMessageHandlerChange: Dispatch<
    SetStateAction<((text: string) => Promise<void>) | null>
  >;
  onCollapseChatPanel?: () => void;
}

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(function ChatArea(
  {
    workspace,
    workspaceChatPanelRef,
    onCreatePRHandlerChange,
    onSendAgentMessageHandlerChange,
    onCollapseChatPanel,
  },
  ref
) {
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
    openFileTab,
  } = useChatTabs({
    workspaceId: workspace.id,
    activeSessionId: workspace.active_session_id,
  });

  useImperativeHandle(ref, () => ({ openFileTab }), [openFileTab]);

  // Resolve sessionId: tab's own session, falling back to workspace's active session
  const tabSessionId =
    activeTab?.type === "chat" ? activeTab.data?.sessionId || workspace.active_session_id : null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <MainContentTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onTabAdd={handleTabAdd}
        onTabReorder={handleTabReorder}
        closedTabs={closedTabs}
        onTabRestore={handleTabRestore}
        onCollapseChatPanel={onCollapseChatPanel}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab?.type === "chat" && tabSessionId && (
          <SessionPanel
            ref={workspaceChatPanelRef}
            sessionId={tabSessionId}
            workspaceId={workspace.id}
            workspacePath={workspace.workspace_path}
            embedded={true}
            onAgentTypeChange={(agentType) => updateChatTabAgentType(activeTab.id, agentType)}
            onSessionStarted={() => markChatTabStarted(activeTab.id)}
            onCreatePR={(handler) => onCreatePRHandlerChange(() => handler)}
            onSendAgentMessage={(handler) => onSendAgentMessageHandlerChange(() => handler)}
          />
        )}

        {activeTab?.type === "file" && activeTab.data?.filePath && (
          <FileViewer filePath={activeTab.data.filePath} />
        )}
      </div>
    </div>
  );
});
