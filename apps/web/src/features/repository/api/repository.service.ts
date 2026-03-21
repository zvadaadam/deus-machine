/**
 * Repository Service
 *
 * All data operations go through the WebSocket q:* protocol.
 * One-shot reads use sendRequest, mutations use sendMutate.
 */

import { sendRequest, sendMutate } from "@/platform/ws";
import type { Repository, Stats } from "../types";
import type { ManifestResponse } from "@shared/types/manifest";

export const RepoService = {
  /**
   * Fetch all repositories
   */
  fetchAll: async (): Promise<Repository[]> => {
    return sendRequest<Repository[]>("repos");
  },

  /**
   * Fetch repository by ID
   * Note: No dedicated request resource for single repo, but "repos" returns all.
   * For now, fetch all and filter. If performance matters, add a "repo" resource.
   */
  fetchById: async (id: string): Promise<Repository> => {
    const repos = await sendRequest<Repository[]>("repos");
    const repo = repos.find((r) => r.id === id);
    if (!repo) throw new Error(`Repository not found: ${id}`);
    return repo;
  },

  /**
   * Fetch system statistics.
   */
  fetchStats: async (): Promise<Stats> => {
    return sendRequest<Stats>("stats");
  },

  /**
   * Add a new repository
   */
  add: async (rootPath: string): Promise<Repository> => {
    const result = await sendMutate<Repository>("addRepo", { root_path: rootPath });
    if (!result.success) throw new Error(result.error || "Failed to add repository");
    return result.data!;
  },

  /**
   * Read opendevs.json manifest for a repo
   */
  fetchManifest: async (repoId: string): Promise<ManifestResponse> => {
    return sendRequest<ManifestResponse>("repoManifest", { repoId });
  },

  /**
   * Write opendevs.json manifest for a repo
   */
  saveManifest: async (repoId: string, manifest: Record<string, unknown>): Promise<void> => {
    const result = await sendMutate("saveRepoManifest", { repoId, ...manifest });
    if (!result.success) throw new Error(result.error || "Failed to save manifest");
  },

  /**
   * Auto-detect manifest from project files (package.json, Cargo.toml, etc.)
   */
  detectManifest: async (repoId: string): Promise<{ manifest: Record<string, unknown> }> => {
    return sendRequest<{ manifest: Record<string, unknown> }>("detectManifest", { repoId });
  },
};
