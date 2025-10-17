import { useState, useCallback, useEffect } from "react";
import { API_CONFIG, getBaseURL } from "../config/api.config";
import type { RepoGroup, DiffStats, Workspace } from "../types";

// BASE_URL is now async - use getBaseURL()
const POLL_INTERVAL = API_CONFIG.POLL_INTERVAL;

export function useDiffStats(repoGroups: RepoGroup[]) {
  const [diffStats, setDiffStats] = useState<Record<string, DiffStats>>({});

  /**
   * Refresh diff stats for all current workspaces
   * Called by polling - updates all at once without staggering
   */
  const refreshDiffStats = useCallback(async (workspaces: Workspace[]) => {
    if (!workspaces || workspaces.length === 0) return;

    // Load all diff stats in parallel (fast update for polling)
    const diffPromises = workspaces.map(async (workspace) => {
      try {
        const diffRes = await fetch(`${await getBaseURL()}/workspaces/${workspace.id}/diff-stats`);
        const diffData = await diffRes.json();
        return { id: workspace.id, data: diffData };
      } catch (error) {
        console.error(`Failed to refresh diff stats for ${workspace.id}:`, error);
        return null;
      }
    });

    const results = await Promise.all(diffPromises);

    // Batch update all diff stats at once to avoid multiple re-renders
    const newDiffStats: Record<string, DiffStats> = {};
    results.forEach(result => {
      if (result) {
        newDiffStats[result.id] = result.data;
      }
    });

    setDiffStats(prev => ({ ...prev, ...newDiffStats }));
  }, []);

  /**
   * Progressive diff stats loading on initial mount
   * Load first 5 immediately, then gradually load the rest
   */
  const loadDiffStatsProgressively = useCallback(async (workspaces: Workspace[]) => {
    if (workspaces.length === 0) return;

    // Load first 5 immediately for quick visual feedback
    const first5 = workspaces.slice(0, 5);
    first5.forEach(async (workspace: Workspace) => {
      try {
        const diffRes = await fetch(`${await getBaseURL()}/workspaces/${workspace.id}/diff-stats`);
        const diffData = await diffRes.json();
        setDiffStats(prev => ({ ...prev, [workspace.id]: diffData }));
      } catch (error) {
        console.error(`Failed to load diff stats for ${workspace.id}:`, error);
      }
    });

    // Load remaining workspaces gradually in background (if any)
    if (workspaces.length > 5) {
      setTimeout(() => {
        const remaining = workspaces.slice(5);
        remaining.forEach(async (workspace: Workspace, index: number) => {
          // Stagger requests by 200ms each to avoid overwhelming
          setTimeout(async () => {
            try {
              const diffRes = await fetch(`${await getBaseURL()}/workspaces/${workspace.id}/diff-stats`);
              const diffData = await diffRes.json();
              setDiffStats(prev => ({ ...prev, [workspace.id]: diffData }));
            } catch (error) {
              console.error(`Failed to load diff stats for ${workspace.id}:`, error);
            }
          }, index * 200);
        });
      }, 500);
    }
  }, []);

  // Initial progressive load
  useEffect(() => {
    const allWorkspaces = repoGroups.flatMap((g: RepoGroup) => g.workspaces);
    if (allWorkspaces.length > 0) {
      loadDiffStatsProgressively(allWorkspaces);
    }
  }, []); // Only run once on mount

  // Polling: Refresh diff stats
  useEffect(() => {
    const interval = setInterval(async () => {
      const allWorkspaces = repoGroups.flatMap((g: RepoGroup) => g.workspaces);
      if (allWorkspaces.length > 0) {
        await refreshDiffStats(allWorkspaces);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [repoGroups, refreshDiffStats]);

  return {
    diffStats,
    setDiffStats,
    refreshDiffStats,
  };
}
