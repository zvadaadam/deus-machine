/**
 * Recent Activity Store
 *
 * Tracks short-lived "agent just touched this file" signals so the file tree
 * can paint trading-terminal-style flashes when the agent writes, edits, or
 * deletes files. Also tracks a per-workspace set of folders that have unseen
 * activity inside them while collapsed — so we can show a persistent dot
 * until the user expands the folder.
 *
 * State is workspace-scoped (keyed by workspaceId) to mirror the pattern used
 * by workspaceLayoutStore. The store is intentionally ephemeral — not
 * persisted across reloads — since flashes are a live signal.
 *
 * Entries auto-expire after `FLASH_TTL_MS`; each `record()` schedules a
 * timer that removes the entry from the store. Dirty folders do not expire
 * automatically — they clear when the user expands the folder (via
 * `clearDirty`) or when the workspace is reset (via `clearWorkspace`).
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type ActivityKind = "write" | "edit" | "delete";

export interface ActivityEntry {
  path: string;
  kind: ActivityKind;
  at: number;
}

/** How long each recent-activity entry stays in the store before auto-expiring.
 *  Matches the flash animation duration so the entry disappears right as the
 *  wash fades out. */
export const FLASH_TTL_MS = 1600;

/** Max entries retained per workspace — bounds memory in pathological bursts. */
const MAX_ENTRIES_PER_WORKSPACE = 64;

interface RecentActivityStore {
  /** Active activity entries per workspace, ordered oldest → newest. */
  byWorkspace: Record<string, ActivityEntry[]>;

  /** Collapsed folders that have unseen writes inside them, per workspace.
   *  Stored as a plain object (keyed by path) because Zustand selectors
   *  prefer primitives + new references for change detection. */
  dirtyByWorkspace: Record<string, Record<string, ActivityKind>>;

  /** Record a new activity. Schedules auto-expiry after FLASH_TTL_MS. */
  record: (workspaceId: string, entry: Omit<ActivityEntry, "at">) => void;

  /** Mark a collapsed folder as having unseen activity inside. */
  markDirty: (workspaceId: string, folderPath: string, kind: ActivityKind) => void;

  /** Clear the dirty marker on a folder — call this when the user expands it. */
  clearDirty: (workspaceId: string, folderPath: string) => void;

  /** Drop all state for a workspace (e.g. when switching away). */
  clearWorkspace: (workspaceId: string) => void;
}

export const useRecentActivityStore = create<RecentActivityStore>()(
  devtools(
    (set, get) => ({
      byWorkspace: {},
      dirtyByWorkspace: {},

      record: (workspaceId, entry) => {
        const at = Date.now();
        const full: ActivityEntry = { ...entry, at };
        set((state) => {
          const prev = state.byWorkspace[workspaceId] ?? [];
          // Drop any older entry for the same path so the map-view is
          // latest-write-wins; append the new entry at the end.
          const filtered = prev.filter((e) => e.path !== full.path);
          filtered.push(full);
          const bounded =
            filtered.length > MAX_ENTRIES_PER_WORKSPACE
              ? filtered.slice(-MAX_ENTRIES_PER_WORKSPACE)
              : filtered;
          return {
            byWorkspace: { ...state.byWorkspace, [workspaceId]: bounded },
          };
        });

        // Schedule expiry. Checking `at` inside the timer guards against races
        // where a newer record for the same path replaced this one — in that
        // case the old `at` won't match and we leave the newer entry alone.
        setTimeout(() => {
          set((state) => {
            const list = state.byWorkspace[workspaceId];
            if (!list) return state;
            const next = list.filter((e) => !(e.path === full.path && e.at === at));
            if (next.length === list.length) return state;
            return {
              byWorkspace: { ...state.byWorkspace, [workspaceId]: next },
            };
          });
        }, FLASH_TTL_MS);
      },

      markDirty: (workspaceId, folderPath, kind) => {
        set((state) => {
          const prev = state.dirtyByWorkspace[workspaceId] ?? {};
          if (prev[folderPath] === kind) return state;
          return {
            dirtyByWorkspace: {
              ...state.dirtyByWorkspace,
              [workspaceId]: { ...prev, [folderPath]: kind },
            },
          };
        });
      },

      clearDirty: (workspaceId, folderPath) => {
        const prev = get().dirtyByWorkspace[workspaceId];
        if (!prev || !(folderPath in prev)) return;
        set((state) => {
          const rest = { ...state.dirtyByWorkspace[workspaceId] };
          delete rest[folderPath];
          return {
            dirtyByWorkspace: { ...state.dirtyByWorkspace, [workspaceId]: rest },
          };
        });
      },

      clearWorkspace: (workspaceId) => {
        set((state) => {
          const nextBy = { ...state.byWorkspace };
          const nextDirty = { ...state.dirtyByWorkspace };
          delete nextBy[workspaceId];
          delete nextDirty[workspaceId];
          return { byWorkspace: nextBy, dirtyByWorkspace: nextDirty };
        });
      },
    }),
    { name: "RecentActivityStore" }
  )
);

/** Imperative action surface — mirrors the workspaceLayoutActions pattern. */
export const recentActivityActions = {
  record: (workspaceId: string, entry: Omit<ActivityEntry, "at">) =>
    useRecentActivityStore.getState().record(workspaceId, entry),
  markDirty: (workspaceId: string, folderPath: string, kind: ActivityKind) =>
    useRecentActivityStore.getState().markDirty(workspaceId, folderPath, kind),
  clearDirty: (workspaceId: string, folderPath: string) =>
    useRecentActivityStore.getState().clearDirty(workspaceId, folderPath),
  clearWorkspace: (workspaceId: string) =>
    useRecentActivityStore.getState().clearWorkspace(workspaceId),
};
