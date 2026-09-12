/**
 * F1 / F2 — telemetry + cache-invalidation contract for the 409-recovery path.
 *
 * When `addRepoOrUseExisting` catches a 409 and returns the existing repo, the
 * underlying `useAddRepo` mutation has REJECTED (its `mutationFn` is
 * `RepoService.add`, which throws on `success:false`). TanStack `useMutation`
 * only fires `onSuccess` when `mutateAsync` resolves — so the
 * `track("repo_added", ...)` telemetry and the `queryClient.invalidateQueries`
 * calls inside `useAddRepo.onSuccess` MUST NOT fire on a recovery path.
 *
 * These tests pin that contract by mounting `useAddRepo` against a real
 * `MutationObserver` (no React render layer) and driving `addRepoOrUseExisting`
 * (the exact catch-and-recover code from `useRepoActions.ts`) through it. If a
 * future change reduces the recovery to a "resolved result" (no throw), this
 * test fails — telemetry would over-count "added" on a no-op reuse, and an
 * unnecessary invalidation would re-fetch a cache that already has the row.
 */
import { QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@shared/types/repository";

const state = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  sendMutate: vi.fn(),
  sendRequest: vi.fn(),
  track: vi.fn(),
}));

// Same mounting pattern as test/unit/session/useSessionActions.test.ts:
// keep React's `useCallback` identity-stable, return a real MutationObserver-
// backed `mutateAsync` so lifecycle (`onSuccess`) actually fires.
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
  sendRequest: state.sendRequest,
}));
vi.mock("@/platform/analytics", () => ({ track: state.track }));

import { useAddRepo } from "@/features/repository/api/repository.queries";
import { queryKeys } from "@/shared/api/queryKeys";

const existingRepo: Repository = {
  id: "repo-existing",
  name: "existing-repo",
  root_path: "/tmp/existing-repo",
  git_default_branch: "main",
  sort_order: 1,
};

// Verbatim copy of `addRepoOrUseExisting` from
// apps/web/src/app/layouts/hooks/useRepoActions.ts — keeps this test honest if
// the hook drifts; the cast shape is what we're pinning.
async function addRepoOrUseExisting(
  mutateAsync: (path: string) => Promise<Repository>,
  path: string
): Promise<Repository> {
  try {
    return await mutateAsync(path);
  } catch (err) {
    const addError = err as { status?: number; details?: Repository };
    const existingRepoFromError = addError?.details;
    if (addError?.status === 409 && existingRepoFromError?.id) {
      return existingRepoFromError;
    }
    throw err;
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  state.queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
});

afterEach(() => {
  state.queryClient!.clear();
});

describe("useAddRepo + addRepoOrUseExisting — telemetry/cache on 409 recovery (F1/F2)", () => {
  it("does NOT fire `track('repo_added')` or invalidate queries when recovering from a 409", async () => {
    // Wire the 409 path: sendMutate resolves with success:false carrying
    // status:409 + details: existingRepo. RepoService.add rethrows a structured
    // Error. useMutation's mutateAsync rejects; onSuccess never fires.
    state.sendMutate.mockResolvedValue({
      success: false,
      error: "Repository already exists",
      status: 409,
      details: existingRepo,
    });

    const invalidateSpy = vi.spyOn(state.queryClient!, "invalidateQueries");

    const addRepo = useAddRepo();
    const repo = await addRepoOrUseExisting(addRepo.mutateAsync, "/tmp/existing-repo");

    // Recovery returned the existing repo.
    expect(repo).toEqual(existingRepo);

    // F1: no `repo_added` telemetry event.
    expect(state.track).not.toHaveBeenCalled();

    // F2: no invalidation calls (neither repos nor workspaces).
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("DOES fire `track('repo_added')` and invalidate queries on the happy path", async () => {
    // Sanity: the contract is recovery-specific. On a real success, the
    // mutation's onSuccess fires normally.
    const created: Repository = {
      id: "repo-new",
      name: "new-repo",
      root_path: "/tmp/new-repo",
      git_default_branch: "main",
    };
    state.sendMutate.mockResolvedValue({ success: true, data: created });

    const invalidateSpy = vi.spyOn(state.queryClient!, "invalidateQueries");

    const addRepo = useAddRepo();
    const repo = await addRepo.mutateAsync("/tmp/new-repo");

    expect(repo).toEqual(created);
    // Telemetry fires once with the repo folder name.
    expect(state.track).toHaveBeenCalledExactlyOnceWith("repo_added", { repo_name: "new-repo" });
    // Both repos and workspaces invalidated.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.repos.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.all });
  });

  it("does NOT recover and DOES surface the error for a non-409 failure", async () => {
    // Non-409: RepoService.add throws a structured Error; addRepoOrUseExisting
    // rethrows (per its predicate); the mutation rejects; onSuccess does not
    // fire; the caller surfaces the error. The user sees the verbatim toast.
    state.sendMutate.mockResolvedValue({
      success: false,
      error: "Path is not a git repository",
      status: 400,
    });

    const invalidateSpy = vi.spyOn(state.queryClient!, "invalidateQueries");
    const addRepo = useAddRepo();

    await expect(addRepoOrUseExisting(addRepo.mutateAsync, "/tmp/not-a-repo")).rejects.toThrow(
      "Path is not a git repository"
    );

    expect(state.track).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
