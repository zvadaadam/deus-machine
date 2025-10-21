import { useState, useCallback, useEffect } from "react";
import { API_CONFIG, getBaseURL } from "@/shared/config/api.config";
import type { RepoGroup, Stats, DiffStats, Workspace } from "@/shared/types";

const POLL_INTERVAL = API_CONFIG.POLL_INTERVAL;

/**
 * Combined hook for managing workspace data and diff stats
 * This avoids circular dependencies and coordinates the two data sources
 */
export function useDashboardData() {
  const [repoGroups, setRepoGroups] = useState<RepoGroup[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");
  const [loading, setLoading] = useState(true);
  const [diffStats, setDiffStats] = useState<Record<string, DiffStats>>({});

  /**
   * Load workspaces and stats only (no diff stats)
   */
  const loadWorkspaces = useCallback(async () => {
    try {
      const baseURL = await getBaseURL();

      // Load grouped workspaces (ready only)
      const groupedRes = await fetch(`${baseURL}/workspaces/by-repo?state=ready`);
      const groupedData = await groupedRes.json();
      setRepoGroups(groupedData);

      // Load stats
      const statsRes = await fetch(`${baseURL}/stats`);
      const statsData = await statsRes.json();
      setStats(statsData);

      setStatus("Connected");
      return groupedData;
    } catch (error) {
      console.error("Failed to load workspaces:", error);
      setStatus(`Error: ${error}`);
      return [];
    }
  }, []);

  /**
   * Refresh diff stats for all current workspaces
   */
  const refreshDiffStats = useCallback(async (workspaces: Workspace[]) => {
    if (!workspaces || workspaces.length === 0) return;

    const baseURL = await getBaseURL();
    const diffPromises = workspaces.map(async (workspace) => {
      try {
        const diffRes = await fetch(`${baseURL}/workspaces/${workspace.id}/diff-stats`);
        const diffData = await diffRes.json();
        return { id: workspace.id, data: diffData };
      } catch (error) {
        console.error(`Failed to refresh diff stats for ${workspace.id}:`, error);
        return null;
      }
    });

    const results = await Promise.all(diffPromises);

    // Batch update all diff stats at once
    const newDiffStats: Record<string, DiffStats> = {};
    results.forEach(result => {
      if (result) {
        newDiffStats[result.id] = result.data;
      }
    });

    setDiffStats(prev => ({ ...prev, ...newDiffStats }));
  }, []);

  /**
   * Progressive diff stats loading
   */
  const loadDiffStatsProgressively = useCallback(async (workspaces: Workspace[]) => {
    if (workspaces.length === 0) return;

    const baseURL = await getBaseURL();
    // Load first 5 immediately
    const first5 = workspaces.slice(0, 5);
    first5.forEach(async (workspace: Workspace) => {
      try {
        const diffRes = await fetch(`${baseURL}/workspaces/${workspace.id}/diff-stats`);
        const diffData = await diffRes.json();
        setDiffStats(prev => ({ ...prev, [workspace.id]: diffData }));
      } catch (error) {
        console.error(`Failed to load diff stats for ${workspace.id}:`, error);
      }
    });

    // Load remaining workspaces gradually
    if (workspaces.length > 5) {
      setTimeout(() => {
        const remaining = workspaces.slice(5);
        remaining.forEach(async (workspace: Workspace, index: number) => {
          setTimeout(async () => {
            try {
              const diffRes = await fetch(`${baseURL}/workspaces/${workspace.id}/diff-stats`);
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

  /**
   * Initial load with progressive diff stats loading
   */
  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Load workspaces first
      const groupedData = await loadWorkspaces();

      // Progressive diff stats loading
      const allWorkspaces = groupedData.flatMap((g: RepoGroup) => g.workspaces);
      if (allWorkspaces.length > 0) {
        await loadDiffStatsProgressively(allWorkspaces);
      }

      setLoading(false);
    } catch (error) {
      console.error("Failed to load data:", error);
      setStatus(`Error: ${error}`);
      setLoading(false);
    }
  }, [loadWorkspaces, loadDiffStatsProgressively]);

  // Initial load on mount
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Polling: Refresh workspaces and diff stats
  useEffect(() => {
    const interval = setInterval(async () => {
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        const allWorkspaces = workspaces.flatMap((g: RepoGroup) => g.workspaces);
        await refreshDiffStats(allWorkspaces);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [loadWorkspaces, refreshDiffStats]);

  return {
    repoGroups,
    stats,
    status,
    loading,
    diffStats,
    setDiffStats,
    loadWorkspaces,
    refreshDiffStats,
    refresh: loadWorkspaces,
  };
}
