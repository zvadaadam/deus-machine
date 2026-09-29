/**
 * Project context for a managed conversation.
 *
 * Present only when a Project agent's conversation renders, so machine inputs
 * (welcome, agent results, agent messages) can show who they came from and
 * open that agent. Ordinary workspace chats never see it.
 */

import { createContext, useContext } from "react";
import type { ProjectAgent } from "@shared/projects";

export interface ProjectConversationValue {
  agents: ProjectAgent[];
  /** Absent when the host cannot show another agent (e.g. a read-only preview). */
  openAgent?: (agentId: string) => void;
}

const ProjectConversationContext = createContext<ProjectConversationValue | null>(null);

export const ProjectConversationProvider = ProjectConversationContext.Provider;

// eslint-disable-next-line react-refresh/only-export-components
export function useProjectConversation(): ProjectConversationValue | null {
  return useContext(ProjectConversationContext);
}
