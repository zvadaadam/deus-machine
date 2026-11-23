import { useSyncExternalStore } from "react";
import { isWorkspaceLinkId, workspaceLink, type WorkspaceLink } from "@shared/workspace-link";
import { currentOpenChatRequest, useOpenChatStore } from "@/features/session/lib/openChat";
import { capabilities } from "@/platform/capabilities";
import { getServerIdFromUrl } from "@/shared/config/backend.config";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useWorkspaceLayoutStore } from "../store/workspaceLayoutStore";

export function workspaceSearch(search: Record<string, unknown>): { session?: string } {
  // Platform callers choose the UUID version and casing of their session IDs.
  // An explicit undefined also removes a refused value from the router's merged search.
  return { session: isWorkspaceLinkId(search.session) ? search.session : undefined };
}

/** A computer's Home, workspace, or chat. The cloud at the root has no server prefix. */
export function workspaceAddress(
  serverId: string | null | undefined,
  workspaceId?: string | null,
  sessionId?: string | null
): string {
  const computer = serverId ? `/s/${encodeURIComponent(serverId)}` : "";
  if (!workspaceId) return computer || "/";
  const path = `${computer}/w/${encodeURIComponent(workspaceId)}`;
  return sessionId ? `${path}?${new URLSearchParams({ session: sessionId })}` : path;
}

export function linkToWorkspace(link: WorkspaceLink): string {
  if (capabilities.singleWindow) return workspaceLink(link);
  const address = workspaceAddress(getServerIdFromUrl(), link.workspaceId, link.sessionId);
  return new URL(address, window.location.origin).href;
}

export function homeForMissingWorkspace(serverId: string | undefined): string | undefined {
  // Cloud discovery can omit an organization's workspaces even on a successful refetch.
  return isCloudDirectWebMode() ? undefined : workspaceAddress(serverId);
}

export function workspaceChatId(workspaceId: string | null | undefined) {
  if (!workspaceId) return undefined;
  return (
    currentOpenChatRequest(workspaceId)?.sessionId ??
    useWorkspaceLayoutStore.getState().layouts[workspaceId]?.activeChatTabSessionId
  );
}

export async function copyWorkspaceLink(
  workspaceId: string,
  target: "workspace" | "chat",
  copy: (link: string) => Promise<boolean>
): Promise<boolean> {
  if (target === "workspace") return copy(linkToWorkspace({ workspaceId }));
  // A request can expire while the menu is open without either store changing.
  const sessionId = workspaceChatId(workspaceId);
  return sessionId ? copy(linkToWorkspace({ workspaceId, sessionId })) : false;
}

function subscribeWorkspaceChat(notify: () => void) {
  const stopRequests = useOpenChatStore.subscribe(notify);
  const stopLayouts = useWorkspaceLayoutStore.subscribe(notify);
  return () => {
    stopRequests();
    stopLayouts();
  };
}

export function useHasWorkspaceChat(workspaceId?: string) {
  const hasChat = () => !!workspaceChatId(workspaceId);
  return useSyncExternalStore(subscribeWorkspaceChat, hasChat, hasChat);
}
