/**
 * Repository Service
 *
 * All data operations go through the WebSocket q:* protocol.
 * One-shot reads use sendRequest, mutations use sendMutate.
 */

import { sendRequest, sendMutate } from "@/platform/ws";
import type { Repository, Stats } from "../types";
import type { ProjectEnvironment } from "@deus-hq/api";

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
   *
   * On a q:mutate failure, throws an `Error` carrying `status` (HTTP status
   * from the delegated route, e.g. 409) and `details` (the route's structured
   * payload, e.g. the existing `Repository` row on a 409 conflict) as own
   * properties. Callers like `addRepoOrUseExisting` read these to recover from
   * a 409 by reusing the already-registered repo instead of surfacing the error.
   */
  add: async (rootPath: string): Promise<Repository> => {
    const result = await sendMutate<Repository>("addRepo", { root_path: rootPath });
    if (!result.success) {
      const e = new Error(result.error || "Failed to add repository") as Error & {
        status?: number;
        details?: unknown;
      };
      if (typeof result.status === "number") e.status = result.status;
      if (result.details !== undefined) e.details = result.details;
      throw e;
    }
    return result.data!;
  },

  fetchEnvironmentFile: async (
    repoId: string
  ): Promise<{ project: ProjectEnvironment | null; branch: string }> =>
    sendRequest("repoEnvironmentFile", { repoId }),

  saveEnvironmentFile: async (repoId: string, project: ProjectEnvironment): Promise<void> => {
    const result = await sendMutate("saveRepoEnvironmentFile", { repoId, project });
    if (!result.success) throw new Error(result.error || "Couldn't save environment file.");
  },
};
