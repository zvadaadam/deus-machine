import { unreadActions } from "@/features/session/store/unreadStore";
import { useSidebarStore } from "@/features/sidebar/store";
import { uiActions } from "@/shared/stores/uiStore";
import type { Workspace } from "../types";
import { useWorkspaceStore, workspaceLayoutActions } from "../store";

export function showWorkspace(workspaceId: string): void {
  // A notification or link can open a workspace while a full-page view or the palette covers it.
  uiActions.closeAllModals();
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
}

export function openWorkspace(workspace: Workspace): void {
  showWorkspace(workspace.id);
  useSidebarStore.getState().expandRepo(workspace.repository_id);
  // Only mark the active tab's session as read — other tabs keep their
  // unread dots until the user actually switches to them.
  const layout = workspaceLayoutActions.getLayout(workspace.id);
  const activeSessionId = layout.activeChatTabSessionId || workspace.current_session_id;
  if (activeSessionId) unreadActions.markRead(activeSessionId);
}
