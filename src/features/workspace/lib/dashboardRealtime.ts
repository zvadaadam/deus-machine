import type { WorkspaceProgressEvent } from "@shared/events";
import type { SessionStatus } from "@shared/types/session";
import type { RepoGroup } from "@shared/types/workspace";

export function isTerminalWorkspaceProgressStep(step: string): boolean {
  return step === "done" || step.startsWith("error");
}

export function applyWorkspaceProgressToRepoGroups(
  repoGroups: RepoGroup[] | undefined,
  event: Pick<WorkspaceProgressEvent, "workspaceId" | "step">
): RepoGroup[] | undefined {
  if (!repoGroups?.length) return repoGroups;

  let changed = false;

  const nextGroups = repoGroups.map((group) => {
    let groupChanged = false;

    const nextWorkspaces = group.workspaces.map((workspace) => {
      if (workspace.id !== event.workspaceId || workspace.init_stage === event.step) {
        return workspace;
      }

      changed = true;
      groupChanged = true;

      return {
        ...workspace,
        init_stage: event.step,
      };
    });

    return groupChanged ? { ...group, workspaces: nextWorkspaces } : group;
  });

  return changed ? nextGroups : repoGroups;
}

export function applySessionStatusToRepoGroups(
  repoGroups: RepoGroup[] | undefined,
  event: { id: string; status: SessionStatus; workspaceId?: string | null }
): RepoGroup[] | undefined {
  if (!repoGroups?.length) return repoGroups;

  let changed = false;

  const nextGroups = repoGroups.map((group) => {
    let groupChanged = false;

    const nextWorkspaces = group.workspaces.map((workspace) => {
      const matchesWorkspaceId = Boolean(event.workspaceId && workspace.id === event.workspaceId);
      const matchesCurrentSessionId = workspace.current_session_id === event.id;

      if (!matchesWorkspaceId && !matchesCurrentSessionId) {
        return workspace;
      }

      if (workspace.session_status === event.status) {
        return workspace;
      }

      changed = true;
      groupChanged = true;

      return {
        ...workspace,
        session_status: event.status,
      };
    });

    return groupChanged ? { ...group, workspaces: nextWorkspaces } : group;
  });

  return changed ? nextGroups : repoGroups;
}
