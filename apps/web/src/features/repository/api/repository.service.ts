/**
 * Repository Service
 *
 * All data operations go through the Node.js backend via HTTP.
 * The backend handles DB reads and external service coordination.
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import type { Repository, Stats } from "../types";
import type { ManifestResponse } from "@shared/types/manifest";

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
   */
  fetchStats: async (): Promise<Stats> => {
    return apiClient.get<Stats>(ENDPOINTS.STATS);
  },

  /**
   * Add a new repository
   */
  add: async (rootPath: string): Promise<Repository> => {
    return apiClient.post<Repository>(ENDPOINTS.REPOS, { root_path: rootPath });
  },

  /**
   * Read opendevs.json manifest for a repo
   */
  fetchManifest: async (repoId: string): Promise<ManifestResponse> => {
    return apiClient.get<ManifestResponse>(ENDPOINTS.REPO_MANIFEST(repoId));
  },

  /**
   * Write opendevs.json manifest for a repo
   */
  saveManifest: async (repoId: string, manifest: Record<string, unknown>): Promise<void> => {
    await apiClient.post(ENDPOINTS.REPO_MANIFEST(repoId), manifest);
  },

  /**
   * Auto-detect manifest from project files (package.json, Cargo.toml, etc.)
   */
  detectManifest: async (repoId: string): Promise<{ manifest: Record<string, unknown> }> => {
    return apiClient.get<{ manifest: Record<string, unknown> }>(
      ENDPOINTS.REPO_DETECT_MANIFEST(repoId)
    );
  },
};
