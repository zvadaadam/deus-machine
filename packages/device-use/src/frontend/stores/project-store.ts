import { create } from "zustand";
import { api } from "../lib/api";

export type BuildStatus = "idle" | "running" | "done" | "failed";

interface ProjectState {
  path: string | null;
  scheme: string | null;
  configuration: string | null;
  schemes: string[];
  buildStatus: BuildStatus;
  setProject: (path: string, scheme?: string, configuration?: string) => Promise<void>;
  refresh: () => Promise<void>;
  setStatus: (status: BuildStatus) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  path: null,
  scheme: null,
  configuration: null,
  schemes: [],
  buildStatus: "idle",
  refresh: async () => {
    const state = await api.getState();
    if (state.project) {
      set({
        path: state.project.path,
        scheme: state.project.scheme ?? null,
        configuration: state.project.configuration ?? null,
      });
      if (state.project.path) {
        const info = await api.getProjectInfo(state.project.path);
        if (info.success && info.result) set({ schemes: info.result.schemes });
      }
    }
  },
  setProject: async (path, scheme, configuration) => {
    await api.setActiveProject(path, scheme, configuration);
    const info = await api.getProjectInfo(path);
    set({
      path,
      scheme: scheme ?? null,
      configuration: configuration ?? null,
      schemes: info.success ? (info.result?.schemes ?? []) : [],
    });
  },
  setStatus: (buildStatus) => set({ buildStatus }),
}));
