import { useMemo, type ReactNode } from "react";
import { ProjectConversationProvider } from "@/features/session/context/ProjectConversationContext";
import { uiActions } from "@/shared/stores/uiStore";
import { useProject } from "../api/projects.queries";
import { projectTabsActions } from "../store/projectTabsStore";

/**
 * Project context for an agent conversation shown outside its Project page (the
 * agent's full workspace view). Opening another agent returns to the Project
 * with that agent's tab selected.
 */
export function ProjectConversationScope({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const project = useProject(projectId).data;
  const value = useMemo(
    () => ({
      agents: project?.agents ?? [],
      openAgent: (agentId: string) => {
        projectTabsActions.open(
          projectId,
          agentId === project?.coordinatorAgentId ? null : agentId
        );
        uiActions.openProjects(projectId);
      },
    }),
    [projectId, project?.agents, project?.coordinatorAgentId]
  );
  return <ProjectConversationProvider value={value}>{children}</ProjectConversationProvider>;
}
