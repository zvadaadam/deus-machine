/**
 * Agent Config Store — Zustand
 *
 * UI-only state for the Agent Config panel:
 * - Active category selection
 */

import { create } from "zustand";
import type { AgentConfigCategory } from "../types";

interface AgentConfigStore {
  activeCategory: AgentConfigCategory;
  setActiveCategory: (cat: AgentConfigCategory) => void;
}

export const useAgentConfigStore = create<AgentConfigStore>((set) => ({
  activeCategory: "skills",
  setActiveCategory: (activeCategory) => set({ activeCategory }),
}));
