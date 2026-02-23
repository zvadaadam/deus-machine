/**
 * Repository Service
 * API methods for repository management
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import { isTauriAvailable } from "@/platform/tauri/invoke";
import { dbGetStats } from "@/platform/tauri/db";
import type { Repository, Stats } from "../types";

/** Shape returned by GET /repos/:id/manifest */
export interface RepoManifestResponse {
  manifest: Record<string, unknown> | null;
  tasks: Array<{
    name: string;
    command: string;
    description: string | null;
    icon: string;
    persistent: boolean;
    mode: "concurrent" | "nonconcurrent";
    depends: string[];
    env: Record<string, string>;
  }>;
}

export const RepoService = {
  /**
   * Fetch all repositories
   */
  fetchAll: async (): Promise<Repository[]> => {
    return apiClient.get<Repository[]>(ENDPOINTS.REPOS);
  },

  /**
   * Fetch repository by ID
   */
  fetchById: async (id: string): Promise<Repository> => {
    return apiClient.get<Repository>(ENDPOINTS.REPO_BY_ID(id));
  },

  /**
   * Fetch system statistics.
   * Uses Rust/rusqlite via Tauri IPC when available (~1ms),
   * falls back to Node.js HTTP when in web mode.
   */
  fetchStats: async (): Promise<Stats> => {
    if (isTauriAvailable()) {
      try {
        return await dbGetStats();
      } catch {
        // Rust DB failed — fall through to HTTP
      }
    }
    return apiClient.get<Stats>(ENDPOINTS.STATS);
  },

  /**
   * Add a new repository
   */
  add: async (rootPath: string): Promise<Repository> => {
    return apiClient.post<Repository>(ENDPOINTS.REPOS, { root_path: rootPath });
  },

  /**
   * Read hive.json manifest for a repo
   */
  fetchManifest: async (repoId: string): Promise<RepoManifestResponse> => {
    return apiClient.get<RepoManifestResponse>(ENDPOINTS.REPO_MANIFEST(repoId));
  },

  /**
   * Write hive.json manifest for a repo
   */
  saveManifest: async (repoId: string, manifest: Record<string, unknown>): Promise<void> => {
    await apiClient.post(ENDPOINTS.REPO_MANIFEST(repoId), manifest);
  },

  /**
   * Auto-detect manifest from project files (package.json, Cargo.toml, etc.)
   */
  detectManifest: async (repoId: string): Promise<{ manifest: Record<string, unknown> }> => {
    return apiClient.get<{ manifest: Record<string, unknown> }>(ENDPOINTS.REPO_DETECT_MANIFEST(repoId));
  },
};
