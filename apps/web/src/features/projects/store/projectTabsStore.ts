/**
 * Which Project agents are open as tabs beside the coordinator. The coordinator
 * tab is always first and never listed; `activeAgentId: null` selects it.
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface ProjectTabs {
  /** Contributor agent IDs in tab order. */
  agentIds: string[];
  activeAgentId: string | null;
}

const EMPTY: ProjectTabs = { agentIds: [], activeAgentId: null };

interface ProjectTabsStore {
  projects: Record<string, ProjectTabs>;
  /** Open (or focus) an agent's tab; null focuses the coordinator. */
  open: (projectId: string, agentId: string | null) => void;
  close: (projectId: string, agentId: string) => void;
  reorder: (projectId: string, agentIds: string[]) => void;
}

export const useProjectTabsStore = create<ProjectTabsStore>()(
  devtools(
    persist(
      (set) => {
        const update = (projectId: string, change: (tabs: ProjectTabs) => ProjectTabs) =>
          set((state) => ({
            projects: {
              ...state.projects,
              [projectId]: change(state.projects[projectId] ?? EMPTY),
            },
          }));
        return {
          projects: {},
          open: (projectId, agentId) =>
            update(projectId, (tabs) => ({
              agentIds:
                agentId === null || tabs.agentIds.includes(agentId)
                  ? tabs.agentIds
                  : [...tabs.agentIds, agentId],
              activeAgentId: agentId,
            })),
          close: (projectId, agentId) =>
            update(projectId, (tabs) => {
              const index = tabs.agentIds.indexOf(agentId);
              if (index === -1) return tabs;
              const agentIds = tabs.agentIds.filter((id) => id !== agentId);
              // Closing the visible tab shows its left neighbour, ending at the coordinator.
              const activeAgentId =
                tabs.activeAgentId === agentId ? (agentIds[index - 1] ?? null) : tabs.activeAgentId;
              return { agentIds, activeAgentId };
            }),
          reorder: (projectId, agentIds) =>
            update(projectId, (tabs) => ({
              agentIds: agentIds.filter((id) => tabs.agentIds.includes(id)),
              activeAgentId: tabs.activeAgentId,
            })),
        };
      },
      {
        name: "project-tabs-store",
        version: 1,
        // Pre-launch: an older shape simply starts with only the coordinator open.
        migrate: () => ({ projects: {} }) as unknown as ProjectTabsStore,
      }
    ),
    { name: "project-tabs-store", enabled: import.meta.env.DEV }
  )
);

export function useProjectTabs(projectId: string): ProjectTabs {
  return useProjectTabsStore((state) => state.projects[projectId] ?? EMPTY);
}

export const projectTabsActions = {
  open: (projectId: string, agentId: string | null) =>
    useProjectTabsStore.getState().open(projectId, agentId),
  close: (projectId: string, agentId: string) =>
    useProjectTabsStore.getState().close(projectId, agentId),
  reorder: (projectId: string, agentIds: string[]) =>
    useProjectTabsStore.getState().reorder(projectId, agentIds),
};
