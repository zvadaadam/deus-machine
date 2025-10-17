import { useState, useEffect, useRef } from "react";
import { getBaseURL } from "../config/api.config";
import type { FileChange, PRStatus, DevServer, DiffStats } from "../types";

// BASE_URL is now async - use getBaseURL()

interface UseFileChangesOptions {
  workspaceId: string | null;
  diffStats: Record<string, DiffStats>;
}

export function useFileChanges({ workspaceId, diffStats }: UseFileChangesOptions) {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [prStatus, setPrStatus] = useState<PRStatus | null>(null);
  const [devServers, setDevServers] = useState<DevServer[]>([]);
  const fileChangesCache = useRef<Record<string, FileChange[]>>({});

  useEffect(() => {
    if (!workspaceId) {
      setFileChanges([]);
      setPrStatus(null);
      setDevServers([]);
      return;
    }

    (async () => {
      const baseURL = await getBaseURL();

      // Note: Diff stats loading is handled by useDashboardData hook

      // Load PR status
      fetch(`${baseURL}/workspaces/${workspaceId}/pr-status`)
        .then(res => res.json())
        .then(data => {
          setPrStatus(data);
        })
        .catch(err => {
          console.error('Failed to load PR status:', err);
          setPrStatus(null);
        });

      // Load dev servers
      fetch(`${baseURL}/workspaces/${workspaceId}/dev-servers`)
        .then(res => res.json())
        .then(data => {
          setDevServers(data.servers || []);
        })
        .catch(err => {
          console.error('Failed to load dev servers:', err);
          setDevServers([]);
        });

      // Check cache first for file changes
      if (fileChangesCache.current[workspaceId]) {
        console.log('✅ Using cached file changes for workspace:', workspaceId);
        setFileChanges(fileChangesCache.current[workspaceId]);
        return;
      }

      // Load from API if not in cache
      console.log('🔄 Loading file changes for workspace:', workspaceId);
      fetch(`${baseURL}/workspaces/${workspaceId}/diff-files`)
        .then(res => res.json())
        .then(data => {
          const files = data.files || [];
          console.log('✅ File changes loaded:', files.length, 'files');
          setFileChanges(files);
          // Cache the result
          fileChangesCache.current[workspaceId] = files;
        })
        .catch(err => {
          console.error('❌ Failed to load file changes:', err);
          setFileChanges([]);
        });
    })();
  }, [workspaceId, diffStats]);

  const clearCache = (wid: string) => {
    delete fileChangesCache.current[wid];
  };

  return {
    fileChanges,
    prStatus,
    devServers,
    clearCache,
  };
}
