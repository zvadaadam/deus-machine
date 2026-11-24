import { useSidebarStore } from "@/features/sidebar/store";
import { uiActions } from "@/shared/stores/uiStore";
import type { Workspace } from "../types";
import { useWorkspaceStore } from "../store";

export function showWorkspace(workspaceId: string): void {
  // A notification or link can open a workspace while a full-page view or the palette covers it.
  uiActions.closeAllModals();
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
}

export function openWorkspace(workspace: Workspace): void {
  showWorkspace(workspace.id);
  useSidebarStore.getState().expandRepo(workspace.repository_id);
}
