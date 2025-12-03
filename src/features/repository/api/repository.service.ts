/**
 * Repository Service
 * API methods for repository management
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import type { Repo, Stats } from "../types";

export const RepoService = {
  /**
   * Fetch all repositories
   */
  fetchAll: async (): Promise<Repo[]> => {
    return apiClient.get<Repo[]>(ENDPOINTS.REPOS);
  },

  /**
   * Fetch repository by ID
   */
  fetchById: async (id: string): Promise<Repo> => {
    return apiClient.get<Repo>(ENDPOINTS.REPO_BY_ID(id));
  },

  /**
   * Fetch system statistics
   */
  fetchStats: async (): Promise<Stats> => {
    return apiClient.get<Stats>(ENDPOINTS.STATS);
  },

  /**
   * Add a new repository
   */
  add: async (rootPath: string): Promise<Repo> => {
    return apiClient.post<Repo>(ENDPOINTS.REPOS, { root_path: rootPath });
  },
};
