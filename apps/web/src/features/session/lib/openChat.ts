// Open a chat: select its workspace and make the chat its active tab. A
// workspace with no layout yet opens on its current chat.

import { useWorkspaceStore } from "@/features/workspace/store";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";

export function openChat(workspaceId: string, sessionId: string): void {
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
  // Only a workspace with layout state gets its tabs changed: a stale link (an
  // archived workspace) must not leave an orphaned entry.
  const existing = useWorkspaceLayoutStore.getState().layouts[workspaceId];
  if (!existing || existing.activeChatTabSessionId === sessionId) return;
  const sessionIds = existing.chatTabSessionIds.includes(sessionId)
    ? existing.chatTabSessionIds
    : [...existing.chatTabSessionIds, sessionId];
  workspaceLayoutActions.setChatTabState(workspaceId, sessionIds, sessionId);
}
