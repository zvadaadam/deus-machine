/**
 * useSaveRepoManifest — primary fix coverage.
 *
 * The hook must update the manifest cache SYNCHRONOUSLY on save success
 * (setQueryData), not by invalidating+refetching. This collapses the post-save
 * refetch window that the EnvironmentSection editor's manifestData-resync
 * effect could clobber user keystrokes typed during the save round-trip
 * through. Workspace manifests inherit from the repo manifest, so those
 * queries are still invalidated for downstream consumers.
 *
 * Pattern: real QueryClient + MutationObserver; only React's hook mounting
 * layer and the IPC transport (`@/platform/ws`) are stubbed. Mirrors
 * test/unit/session/useSessionActions.test.ts.
 */

import { QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSaveRepoManifest } from "@/features/repository/api/repository.queries";
import { queryKeys } from "@/shared/api/queryKeys";
import type { ManifestResponse, NormalizedTask } from "@shared/types/manifest";

const state = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  sendMutate: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => state.queryClient!,
    useMutation: <TData, TVariables, TContext>(
      options: MutationObserverOptions<TData, Error, TVariables, TContext>
    ) => {
      const observer = new actual.MutationObserver(state.queryClient!, options);
      return {
        mutateAsync: (variables: TVariables) => observer.mutate(variables),
        isPending: false,
      };
    },
  };
});
vi.mock("@/platform/ws", () => ({
  sendMutate: state.sendMutate,
}));

const REPO = "repo-abc";
const TASK_BUILD: NormalizedTask = {
  name: "build",
  command: "bun run build",
  description: null,
  icon: "terminal",
  persistent: false,
  mode: "nonconcurrent",
  depends: [],
  env: {},
};

beforeEach(() => {
  vi.resetAllMocks();
  state.sendMutate.mockResolvedValue({ success: true });
  state.queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, staleTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });
});

afterEach(() => {
  state.queryClient!.clear();
  vi.restoreAllMocks();
});

async function saveManifest(repoId: string, manifest: Record<string, unknown>): Promise<void> {
  const mutation = useSaveRepoManifest();
  await mutation.mutateAsync({ repoId, manifest });
}

describe("useSaveRepoManifest — cache update on success", () => {
  it("writes the saved manifest synchronously into the manifest cache (no async refetch)", async () => {
    expect(state.queryClient!.getQueryData(queryKeys.repos.manifest(REPO))).toBeUndefined();

    const manifest = { version: 1, scripts: { setup: "bun install" } };
    await saveManifest(REPO, manifest);

    expect(
      state.queryClient!.getQueryData<ManifestResponse>(queryKeys.repos.manifest(REPO))
    ).toEqual({ manifest, tasks: [] });
  });

  it("preserves the cached `tasks` array (server-normalized tasks) when the cache had prior data", async () => {
    const initial: ManifestResponse = {
      manifest: { version: 1 },
      tasks: [TASK_BUILD],
    };
    state.queryClient!.setQueryData<ManifestResponse>(queryKeys.repos.manifest(REPO), initial);

    const manifest = { version: 1, scripts: { setup: "bun install" } };
    await saveManifest(REPO, manifest);

    const cached = state.queryClient!.getQueryData<ManifestResponse>(
      queryKeys.repos.manifest(REPO)
    );
    expect(cached).toEqual({ manifest, tasks: [TASK_BUILD] });
    // Structural sharing creates a deep-equal copy of the manifest (the
    // top-level reference is not preserved when keys differ from the prior
    // cache), but the persisted *content* is exactly what we saved.
    expect(cached?.manifest).toEqual(manifest);
    // The tasks array reference IS preserved — it carries through from the
    // previous cache entry unmodified (structural sharing recognizes the
    // identity).
    expect(cached?.tasks).toBe(initial.tasks);
  });

  it("sets tasks to [] when no prior cache existed (cold cache / first save)", async () => {
    await saveManifest(REPO, { version: 1 });
    expect(
      state.queryClient!.getQueryData<ManifestResponse>(queryKeys.repos.manifest(REPO))
    ).toEqual({ manifest: { version: 1 }, tasks: [] });
  });

  it("does NOT invalidate the manifest query (the cache is the source of truth)", async () => {
    const invalidateSpy = vi.spyOn(state.queryClient, "invalidateQueries");

    await saveManifest(REPO, { version: 1, scripts: { run: "bun run dev" } });

    const manifestInvalidations = invalidateSpy.mock.calls.filter(
      ([arg]) =>
        Array.isArray(arg.queryKey) &&
        arg.queryKey[0] === "repos" &&
        arg.queryKey.length >= 2 &&
        arg.queryKey[1] === "manifest"
    );
    expect(manifestInvalidations).toHaveLength(0);
  });

  it("still invalidates the dependent workspace queries (they inherit the repo manifest)", async () => {
    const invalidateSpy = vi.spyOn(state.queryClient, "invalidateQueries");

    await saveManifest(REPO, { version: 1 });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.all });
  });

  it("sends the manifest over IPC via saveRepoManifest", async () => {
    const manifest = { version: 1, scripts: { setup: "bun install" } };
    await saveManifest(REPO, manifest);

    expect(state.sendMutate).toHaveBeenCalledTimes(1);
    expect(state.sendMutate).toHaveBeenCalledWith("saveRepoManifest", {
      repoId: REPO,
      ...manifest,
    });
  });

  it("rethrows when the backend rejects the save and leaves the cache untouched", async () => {
    state.sendMutate.mockResolvedValueOnce({ success: false, error: "boom" });

    await expect(saveManifest(REPO, { version: 1 })).rejects.toThrow("boom");

    expect(state.queryClient!.getQueryData(queryKeys.repos.manifest(REPO))).toBeUndefined();
  });
});
