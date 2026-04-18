import { create } from "zustand";

/** Chrome / layout state that doesn't belong in domain stores (sim, refs, logs).
 *  Currently just the sidebar collapsed state; will grow with panel visibility,
 *  themes, density, etc. Persists to localStorage so the layout survives reloads. */

const STORAGE_KEY = "device-use.ui.v1";

interface Persisted {
  sidebarCollapsed: boolean;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sidebarCollapsed: false };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return { sidebarCollapsed: Boolean(parsed.sidebarCollapsed) };
  } catch {
    return { sidebarCollapsed: false };
  }
}

function savePersisted(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / private mode — drop silently
  }
}

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: loadPersisted().sidebarCollapsed,
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    savePersisted({ sidebarCollapsed: next });
  },
  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed });
    savePersisted({ sidebarCollapsed: collapsed });
  },
}));
