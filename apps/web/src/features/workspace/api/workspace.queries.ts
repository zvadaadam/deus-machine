/**
 * Workspace Query Hooks
 * TanStack Query hooks for workspace-related data fetching
 */

import {
  useQuery,
  useMutation,
  useMutationState,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { produce } from "immer";
import { api } from "@shared/api";
import type { ReportedOrigin } from "@shared/protocol-types";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import { native } from "@/platform";
import { call, getRuntimeClient } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import type { RepoGroup, DiffStats, Workspace } from "../types";
import type { PRStatus } from "@/shared/types";
import type { WorkspaceStatus } from "@shared/enums";
import { mergeWorkspaceDelta } from "../lib/workspace.utils";
import { diffStatsToAsk } from "../lib/diffStats";
import { track } from "@/platform/analytics";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";

// Include errors so a failed start stays visible with its reason.
// Optimistic writes must use this state in their query key to reach the cache the sidebar renders.
export const SIDEBAR_WORKSPACE_STATE = "ready,initializing,error";
const removeWorkspaceKey = ["removeWorkspace"] as const;

// The query reads once for the first paint, and the subscription pushes each new value into the cache.
export function useWorkspacesByRepo(state: string = SIDEBAR_WORKSPACE_STATE) {
  const pending = useMutationState({
    filters: { mutationKey: removeWorkspaceKey, status: "pending" },
    select: (mutation) => mutation.state.variables,
  });
  useQuerySubscription(api.workspaces, {
    queryKey: queryKeys.workspaces.byRepo(state),
    params: { state },
    mergeDelta: mergeWorkspaceDelta,
  });

  return useQuery({
    queryKey: queryKeys.workspaces.byRepo(state),
    queryFn: () => call(api.workspaces, { state }),
    // The host publishes the removal before acknowledging it. Until then, hide it only in the view.
    select: pending.length
      ? (groups) =>
          groups.map((group) => ({
            ...group,
            workspaces: group.workspaces.filter((workspace) => !pending.includes(workspace.id)),
          }))
      : undefined,
    staleTime: Infinity, // WS subscription keeps data fresh
    refetchOnWindowFocus: false, // Subscription handles freshness
  });
}

/**
 * Fetch diff stats for all sidebar workspaces in bulk.
 *
 * One query for the whole sidebar instead of a hook per row.
 * - Initial load: fetches ALL ready workspaces in parallel batches of 15
 * - Polling: only re-fetches workspaces with session_status === "working" (5s)
 * - Idle: no polling (staleTime 30s, refetch on window focus)
 * - On workspace list change: seeds from per-workspace cache, fetches only missing/working
 *
 * Guard: state === "ready" — initializing worktrees have incomplete git state
 * (missing HEAD, partial index → garbage diffs like +500K/-1M). Setup script
 * diffs remain visible: setup changes are ordinary working-tree changes.
 */
export function useBulkDiffStats(repoGroups: RepoGroup[]) {
  const queryClient = useQueryClient();

  // Stable, de-duplicated IDs for query key — only ready workspaces.
  const workspaceIds = useMemo(() => {
    const ids = repoGroups.flatMap((g) =>
      g.workspaces.filter((w) => w.state === "ready").map((w) => w.id)
    );
    return Array.from(new Set(ids)).sort();
  }, [repoGroups]);

  // The ready rows themselves: what `diffStatsToAsk` reads.
  const readyRows = useMemo(
    () => repoGroups.flatMap((g) => g.workspaces).filter((w) => w.state === "ready"),
    [repoGroups]
  );

  // Only workspaces with active sessions need polling.
  const hasWorkingWorkspaces = readyRows.some((w) => w.session_status === "working");

  return useQuery({
    queryKey: ["bulk-diff-stats", workspaceIds],
    enabled: workspaceIds.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval: hasWorkingWorkspaces ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      // Seed from per-workspace cache for workspaces we already have data for
      const results: Record<string, DiffStats> = {};
      for (const id of workspaceIds) {
        const cached = queryClient.getQueryData<DiffStats>(queryKeys.workspaces.diffStats(id));
        if (cached) results[id] = cached;
      }

      // Fetch: missing workspaces + working workspaces (need fresh data)
      const idsToFetch = diffStatsToAsk(readyRows, (id) => results[id]);

      if (idsToFetch.length === 0) return results;

      // Parallel batches of 15 — balances throughput vs resource pressure
      const BATCH_SIZE = 15;
      for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
        const batch = idsToFetch.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(
          batch.map((workspaceId) => call(api.diffStats, { workspaceId }))
        );

        batch.forEach((id, j) => {
          if (settled[j].status === "fulfilled") {
            results[id] = settled[j].value;
            queryClient.setQueryData(queryKeys.workspaces.diffStats(id), settled[j].value);
          }
        });
      }

      return results;
    },
  });
}

/**
 * The open cloud workspace's channel just opened, or its computer woke: its diff
 * numbers are read again, instead of the zero read before (`lib/diffStats.ts`).
 */
export function rereadDiffStats(
  queryClient: Pick<ReturnType<typeof useQueryClient>, "removeQueries" | "invalidateQueries">,
  workspaceId: string
): void {
  queryClient.removeQueries({ queryKey: queryKeys.workspaces.diffStats(workspaceId), exact: true });
  void queryClient.invalidateQueries({ queryKey: ["bulk-diff-stats"] });
}

/**
 * Fetch file changes for a workspace
 * Conditionally polls only when workspace is actively working.
 *
 * When `isWatched` is true (file watcher active via notify crate),
 * polling is disabled — cache invalidation comes from `fileChanges` events.
 * Falls back to 5s polling when not watched.
 *
 * IMPORTANT: Requires workspaceState === "ready" to avoid fetching diffs
 * against incomplete worktrees during initialization. Running git diff on
 * an initializing worktree produces garbage (e.g. +500K/-1M) that gets
 * cached for 30s, persisting as phantom diffs even after the workspace
 * becomes ready. Guard here, not in the UI.
 */
export function useFileChanges(
  workspaceId: string | null,
  sessionStatus?: string | null,
  isWatched: boolean = false,
  workspaceState?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ""),
    queryFn: async () => {
      const result = await call(api.diffFiles, { workspaceId: workspaceId! });
      return {
        files: result.files || [],
        truncated: result.truncated ?? false,
        totalCount: result.total_count ?? result.files?.length ?? 0,
      };
    },
    enabled: !!workspaceId && workspaceState === "ready",
    staleTime: 30000,
    // Events handle invalidation when watched; fall back to polling otherwise
    refetchInterval: isWatched ? false : sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Check GitHub integration availability and auth status.
 * Cached with 5-minute staleTime — rarely changes during a session.
 * Gates usePRStatus to avoid wasted GitHub calls when unavailable or unauthenticated.
 */
export function useGhStatus() {
  return useQuery({
    queryKey: queryKeys.github.ghStatus,
    queryFn: () => call(api.ghStatus),
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Sign this computer's GitHub CLI in (`ghLogin`): GitHub's page opens, and
 * `page` holds the one-time code to enter there (and that page, `openPage`)
 * until gh is done, for the surface to show. Then `ghStatus` is read again;
 * `onSignedIn` runs once it shows the account.
 */
export function useGhSignIn(onSignedIn?: () => unknown) {
  const ghStatus = useGhStatus();
  const [page, setPage] = useState<{ code: string; url: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const started = await call(api.ghLogin);
      setPage(started);
      void native.window.openExternal(started.url);
      try {
        await call(api.ghLoginDone, undefined, { timeoutMs: 11 * 60_000 });
      } finally {
        setPage(null);
      }
      if (!(await ghStatus.refetch()).data?.isAuthenticated) {
        throw new Error("GitHub sign-in finished, but Deus could not verify it yet");
      }
      toast.success("GitHub connected");
      await onSignedIn?.();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
  const openPage = () => page && void native.window.openExternal(page.url);
  return { ...mutation, page, openPage };
}

/**
 * Fetch open pull requests for a repository.
 * Used by the "Create Workspace from PR" picker modal.
 * Enabled only when a repoId is provided (i.e., modal is open).
 */
export function useRepoPrs(repoId: string | null) {
  return useQuery({
    queryKey: queryKeys.repos.prs(repoId || ""),
    queryFn: () => call(api.repoPrs, { repoId: repoId! }),
    enabled: !!repoId,
    staleTime: 30_000,
  });
}

/**
 * Fetch a repository's branches: origin's, or its own when it has no origin.
 * Used by BranchSelector (welcome screen + Create PR).
 *
 * The request rejects immediately if the WS isn't connected yet (common
 * during app startup and Vite HMR). We retry with exponential backoff
 * so the query self-heals once the WS is ready (~1-2s after load).
 */
export function useRepoBranches(repoId: string | null, organizationId?: string | null) {
  return useQuery({
    queryKey: queryKeys.repos.branches(repoId || "", organizationId),
    // A project with no folder here is read from GitHub, with this organization's access.
    queryFn: () => call(api.repoBranches, { repoId: repoId!, organizationId }),
    enabled: !!repoId,
    staleTime: 30_000,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });
}

/**
 * Fetch PR status for a workspace.
 *
 * Gated on GitHub integration being available + authenticated.
 * Polls every 30s while agent is working (to detect PR creation),
 * 60s while CI is pending post-session (CI runs 2-15min after push),
 * stops polling otherwise.
 */
export function usePRStatus(
  workspaceId: string | null,
  options?: { ghInstalled?: boolean; ghAuthenticated?: boolean; sessionStatus?: string }
) {
  const { ghInstalled = true, ghAuthenticated = true, sessionStatus } = options ?? {};
  return useQuery({
    queryKey: queryKeys.workspaces.prStatus(workspaceId || ""),
    queryFn: () => call(api.prStatus, { workspaceId: workspaceId! }),
    enabled: !!workspaceId && ghInstalled && ghAuthenticated,
    staleTime: 10_000,
    refetchInterval: (query) => {
      // While agent is working: poll every 30s to detect PR creation/updates.
      if (sessionStatus === "working") return 30_000;

      // After agent stops: CI checks typically run 2-15min. Poll every 60s
      // while CI is pending so the user sees updates without manual refresh.
      const data = query.state.data as PRStatus | null | undefined;
      if (data?.has_pr && data?.ci_status === "pending") return 60_000;

      // No PR or CI resolved: stop polling. Window focus refetch handles edge cases.
      return false;
    },
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch specific file diff
 */
export function useFileDiff(workspaceId: string | null, filePath: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFile(workspaceId || "", filePath || ""),
    queryFn: async () => {
      const result = await call(api.diffFile, { workspaceId: workspaceId!, file: filePath! });
      return {
        diff: result.diff ?? "",
        oldContent: result.old_content ?? null,
        newContent: result.new_content ?? null,
      };
    },
    enabled: !!workspaceId && !!filePath,
    staleTime: 10000, // Cache for 10s since diffs are expensive
  });
}

/** Params accepted by the create-workspace mutation. */
type CreateWorkspaceParams =
  | string
  | {
      repositoryId: string;
      /** 'cloud' provisions an agnt sandbox instead of a local worktree. */
      location?: "local" | "cloud";
      /** With `location: "cloud"`, the organization it starts in (the backend's default when absent). */
      organization_id?: string;
      source_branch?: string;
      pr_number?: number;
      pr_url?: string;
      pr_title?: string;
      target_branch?: string;
    };

/**
 * Create a workspace. The backend writes the row and answers at once (the
 * slow work runs in the background), and pushes the workspace list, so the
 * real row is in the sidebar within a frame or two: nothing is faked here.
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateWorkspaceParams) => {
      const { repositoryId, ...options } =
        typeof params === "string" ? { repositoryId: params } : params;
      const { workspaceId } = await call(api.createWorkspace, {
        repository_id: repositoryId,
        ...options,
      });
      // The full row arrives on the `workspaces` subscription.
      return { id: workspaceId, repository_id: repositoryId };
    },

    onSuccess: (_data, params) => {
      const repositoryId = typeof params === "string" ? params : params.repositoryId;
      track("workspace_created", { repository_id: repositoryId });
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

function useRemoveWorkspace(action: typeof api.archiveWorkspace | typeof api.deleteWorkspace) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: removeWorkspaceKey,
    mutationFn: (workspaceId: string) => call(action, { workspaceId }),
    retry: false,
    onSuccess: (_data, workspaceId) => {
      if (action === api.archiveWorkspace) {
        track("workspace_archived", { workspace_id: workspaceId });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.archived.all });
      }
    },
  });
}

export function useArchiveWorkspace() {
  return useRemoveWorkspace(api.archiveWorkspace);
}

export function useDeleteFailedWorkspace() {
  return useRemoveWorkspace(api.deleteWorkspace);
}

/**
 * Start a failed workspace again. Nothing optimistic: the backend flips the
 * row to "initializing" and pushes it, and a refusal leaves the failure shown.
 */
export function useRetryWorkspaceInit() {
  return useMutation({
    mutationFn: (workspaceId: string) => call(api.retryWorkspaceInit, { workspaceId }),
    retry: false,
  });
}

/**
 * Update workspace workflow status (backlog/in-progress/in-review/done/canceled).
 * Optimistic: updates sidebar immediately, WS subscription confirms.
 */
export function useUpdateWorkspaceStatus() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.workspaces.byRepo(SIDEBAR_WORKSPACE_STATE);

  return useMutation({
    mutationFn: (input: { workspaceId: string; status: WorkspaceStatus }) =>
      call(api.updateWorkspaceStatus, input),

    onMutate: async ({ workspaceId, status }) => {
      await queryClient.cancelQueries({ queryKey });
      let previousStatus: WorkspaceStatus | undefined;

      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          for (const repo of draft) {
            const ws = repo.workspaces.find((w) => w.id === workspaceId);
            if (ws) {
              previousStatus = ws.status;
              ws.status = status;
              break;
            }
          }
        });
      });

      return { workspaceId, previousStatus };
    },

    onError: (_err, _vars, context) => {
      if (context?.previousStatus === undefined) return;
      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          for (const repo of draft) {
            const ws = repo.workspaces.find((w) => w.id === context.workspaceId);
            if (ws) {
              ws.status = context.previousStatus!;
              break;
            }
          }
        });
      });
    },

    onSuccess: (_data, { workspaceId, status }) => {
      track("workspace_status_changed", { workspace_id: workspaceId, status });
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export type ArchivedWorkspace = Pick<
  Workspace,
  "id" | "slug" | "title" | "git_branch" | "kind" | "organization_id"
> & {
  archived_at: string;
  archived_by: ReportedOrigin | null;
};

export function useArchivedWorkspaces(
  repositoryId: string,
  count: number | undefined,
  open: boolean
) {
  return useQuery({
    queryKey: queryKeys.workspaces.archived.byRepo(repositoryId, count),
    // Replace this request with call(api.archivedWorkspaces, { repositoryId }) when the shared declaration lands.
    queryFn: () =>
      getRuntimeClient().sendRequest<ArchivedWorkspace[]>("archivedWorkspaces", { repositoryId }),
    enabled: open && count !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

/** Restore from the sidebar or Undo. The live workspace row tells us what opened. */
export function useUnarchiveWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => call(api.updateWorkspace, { workspaceId, state: "ready" }),
    onSuccess: (_data, workspaceId) => {
      track("workspace_unarchived", { workspace_id: workspaceId });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.archived.all });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}

/**
 * Fetch effective project environment and Run commands for a workspace.
 * File changes invalidate this query. The direct cloud chat has no backend
 * command runner; its environment settings use the cloud settings API.
 */
export function useProjectEnvironment(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.environment(workspaceId || ""),
    queryFn: () => call(api.workspaceEnvironment, { workspaceId: workspaceId! }),
    enabled: !!workspaceId && !isCloudDirectWebMode(),
    staleTime: Infinity,
  });
}
