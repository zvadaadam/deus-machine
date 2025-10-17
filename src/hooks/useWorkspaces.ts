import { useState, useCallback, useEffect } from "react";
import { API_CONFIG, getBaseURL } from "../config/api.config";
import type { RepoGroup, Stats } from "../types";

// BASE_URL is now async - use getBaseURL()
const POLL_INTERVAL = API_CONFIG.POLL_INTERVAL;

export function useWorkspaces() {
  const [repoGroups, setRepoGroups] = useState<RepoGroup[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");
  const [loading, setLoading] = useState(true);

  /**
   * Load workspaces and stats only (no diff stats)
   * Called by polling to update workspace list
   */
  const loadWorkspaces = useCallback(async () => {
    try {
      // Load grouped workspaces (ready only)
      const groupedRes = await fetch(`${await getBaseURL()}/workspaces/by-repo?state=ready`);
      const groupedData = await groupedRes.json();
      setRepoGroups(groupedData);

      // Load stats
      const statsRes = await fetch(`${await getBaseURL()}/stats`);
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
   * Initial load
   * Only called once on mount
   */
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      await loadWorkspaces();
      setLoading(false);
    } catch (error) {
      console.error("Failed to load data:", error);
      setStatus(`Error: ${error}`);
      setLoading(false);
    }
  }, [loadWorkspaces]);

  // Initial load on mount
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Polling: Refresh workspaces list
  useEffect(() => {
    const interval = setInterval(async () => {
      await loadWorkspaces();
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [loadWorkspaces]);

  return {
    repoGroups,
    stats,
    status,
    loading,
    loadWorkspaces,
    refresh: loadWorkspaces,
  };
}
