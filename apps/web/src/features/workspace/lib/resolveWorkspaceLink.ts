import type { RepoGroup, Workspace } from "../types";
import type { WorkspaceLink } from "@shared/workspace-link";

export const NO_OPEN_WORKSPACE = "No open workspace matches that link on this computer.";

export function findOpenWorkspace(groups: RepoGroup[], workspaceId: string): Workspace | undefined {
  for (const group of groups) {
    const workspace = group.workspaces.find((row) => row.id === workspaceId);
    if (workspace) return workspace;
  }
  return undefined;
}

export function resolveWorkspaceLink(
  link: WorkspaceLink,
  groups: RepoGroup[],
  chats: readonly { id: string }[]
): { workspace?: Workspace; sessionId?: string; message?: string } {
  const workspace = findOpenWorkspace(groups, link.workspaceId);
  if (!workspace) return { message: NO_OPEN_WORKSPACE };
  if (!link.sessionId) return { workspace };
  if (chats.some((chat) => chat.id === link.sessionId))
    return { workspace, sessionId: link.sessionId };
  return { workspace, message: "That chat is no longer open in this workspace." };
}
