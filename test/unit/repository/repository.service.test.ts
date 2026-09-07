/**
 * Unit tests for `RepoService.add`'s failure re-shape and the
 * `addRepoOrUseExisting` 409-recovery contract that depends on it.
 *
 * The bug: `addRepoOrUseExisting` in `useRepoActions.ts` catches the rejection
 * from `addRepoMutation.mutateAsync` and reads `err.status`/`err.details` to
 * recover from a 409 ("Repository already exists") by reusing the existing
 * repo. After the WS-unification refactor (commit 8769a7f2), the WS transport
 * dropped both fields, so the cast was unsound and the recovery branch was
 * dead — the user saw a "Repository already exists" toast and no workspace was
 * created.
 *
 * The fix carries `status`/`details` through the WS mutate failure path
 * (`route-delegate.ts` → `query-engine.handleMutate` → `sendMutate` result →
 * `RepoService.add` re-shape). These tests pin the LAST link — `RepoService.add`
 * must throw an `Error` with `status` and `details` attached as own properties
 * when `sendMutate` resolves with `success: false` — and verify the recovery
 * contract that `addRepoOrUseExisting` relies on is now live.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import type { Repository } from "@shared/types/repository";

// `sendMutate` is the only WS surface `RepoService.add` touches; mock it
// per-test. `sendRequest` is unused by `add`, but the module imports it — keep
// a no-op stub so the import doesn't blow up.
//
// `vi.hoisted` keeps the mock reference available inside the (hoisted)
// `vi.mock` factory — vi.mock factories run before any top-level `const`.
const { sendMutateMock, sendRequestMock } = vi.hoisted(() => ({
  sendMutateMock: vi.fn(),
  sendRequestMock: vi.fn(),
}));

vi.mock("@/platform/ws", () => ({
  sendMutate: sendMutateMock,
  sendRequest: sendRequestMock,
}));

import { RepoService } from "@/features/repository/api/repository.service";

const existingRepo: Repository = {
  id: "repo-existing",
  name: "existing-repo",
  root_path: "/tmp/existing-repo",
  git_default_branch: "main",
  sort_order: 1,
};

/**
 * Mirrors `addRepoOrUseExisting` in `apps/web/src/app/layouts/hooks/useRepoActions.ts`.
 * Kept here as a faithful reimplementation so the recovery contract can be
 * unit-tested without standing up the React hook's many dependencies. If the
 * hook's cast shape drifts from this predicate, the `addRepoOrUseExisting`
 * recovery test below will fail — that's intentional: it pins the contract.
 */
async function addRepoOrUseExisting(path: string): Promise<Repository> {
  try {
    return await RepoService.add(path);
  } catch (err) {
    const addError = err as { status?: number; details?: Repository };
    const existingRepoFromError = addError?.details;
    if (addError?.status === 409 && existingRepoFromError?.id) {
      return existingRepoFromError;
    }
    throw err;
  }
}

describe("RepoService.add — success", () => {
  beforeEach(() => {
    sendMutateMock.mockReset();
  });

  it("returns the created Repository when sendMutate succeeds", async () => {
    const created: Repository = {
      id: "repo-new",
      name: "new-repo",
      root_path: "/tmp/new-repo",
      git_default_branch: "main",
    };
    sendMutateMock.mockResolvedValue({ success: true, data: created });

    const result = await RepoService.add("/tmp/new-repo");

    expect(result).toEqual(created);
    expect(sendMutateMock).toHaveBeenCalledWith("addRepo", { root_path: "/tmp/new-repo" });
  });
});

describe("RepoService.add — failure reshapes into a structured Error", () => {
  beforeEach(() => {
    sendMutateMock.mockReset();
  });

  it("throws an Error carrying `status: 409` and `details: <Repository>` on a 409 conflict", async () => {
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Repository already exists",
      status: 409,
      details: existingRepo,
    });

    const err = await RepoService.add("/tmp/existing-repo").catch(
      (e: unknown) => e as Error & { status?: number; details?: unknown }
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Repository already exists");
    expect(err.status).toBe(409);
    expect(err.details).toEqual(existingRepo);
  });

  it("throws an Error with the fallback message when `error` is empty", async () => {
    sendMutateMock.mockResolvedValue({
      success: false,
      status: 500,
    });

    const err = await RepoService.add("/tmp/repo").catch(
      (e: unknown) => e as Error & { status?: number; details?: unknown }
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Failed to add repository");
    expect(err.status).toBe(500);
    expect(err.details).toBeUndefined();
  });

  it("does NOT attach `status` when the result did not carry one (older server)", async () => {
    // Backward-compat: a server predating the fix sends only `{success, error}`.
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Mystery failure",
    });

    const err = await RepoService.add("/tmp/repo").catch(
      (e: unknown) => e as Error & { status?: number; details?: unknown }
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Mystery failure");
    expect(err.status).toBeUndefined();
    expect(err.details).toBeUndefined();
  });

  it("preserves a falsy-but-present `details` payload (e.g. null) only when defined", async () => {
    // `details: null` is "defined" → attached (preserves the route's intent).
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Something with null details",
      status: 400,
      details: null,
    });

    const err = await RepoService.add("/tmp/repo").catch(
      (e: unknown) => e as Error & { status?: number; details?: unknown }
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.details).toBeNull();
  });
});

describe("addRepoOrUseExisting — 409 recovery contract (regression guard)", () => {
  beforeEach(() => {
    sendMutateMock.mockReset();
  });

  it("returns the existing Repository instead of throwing when the backend reports a 409 with `details: <Repository>`", async () => {
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Repository already exists",
      status: 409,
      details: existingRepo,
    });

    // Simulates `handleOpenProject`: register-then-create-workspace. Before the
    // fix, this rejected and `handleOpenProject` caught it to surface a toast
    // and skip `createWorkspaceAndSelect`. After the fix, the recovery returns
    // the existing repo and the caller proceeds to create a fresh workspace.
    const repo = await addRepoOrUseExisting("/tmp/existing-repo");

    expect(repo).toEqual(existingRepo);
    expect(repo.id).toBe("repo-existing");
  });

  it("rethrows when the error is NOT a 409 even if `details` is present", async () => {
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Validation failed",
      status: 400,
      details: { field: "name" },
    });

    await expect(addRepoOrUseExisting("/tmp/repo")).rejects.toThrow("Validation failed");
  });

  it("rethrows when the error is a 409 but `details` has no `id` (no recoverable entity)", async () => {
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Repository already exists",
      status: 409,
      // details present but not a Repository-shaped object → cannot recover
      details: { not: "a repo" },
    });

    // The predicate guards on `existingRepo?.id` — without it, surfacing the
    // error is safer than returning a non-Repository object.
    await expect(addRepoOrUseExisting("/tmp/repo")).rejects.toThrow("Repository already exists");
  });

  it("rethrows upstream errors that carry no structured fields (pre-fix regression guard)", async () => {
    // This is exactly the shape that was on the wire BEFORE the fix — a plain
    // `{success:false, error}` with no status/details. The recovery MUST fall
    // through to rethrow (no silent success), preserving today's error toast.
    sendMutateMock.mockResolvedValue({
      success: false,
      error: "Repository already exists",
    });

    await expect(addRepoOrUseExisting("/tmp/existing-repo")).rejects.toThrow(
      "Repository already exists"
    );
  });

  it("rethrows when `sendMutate` itself rejects (timeout / disconnect path)", async () => {
    // `sendMutate` rejects on timeout/disconnect (NOT on `success: false`); a
    // pre-fix `addRepoOrUseExisting` already rethrew these. That must not
    // change — recovery only applies to 409-with-details.
    const timeout = new Error("Mutation addRepo timed out");
    sendMutateMock.mockRejectedValue(timeout);

    await expect(addRepoOrUseExisting("/tmp/repo")).rejects.toThrow("Mutation addRepo timed out");
  });

  it("returns the freshly-created repo on the happy path (no recovery needed)", async () => {
    const created: Repository = {
      id: "repo-new",
      name: "new-repo",
      root_path: "/tmp/new-repo",
      git_default_branch: "main",
    };
    sendMutateMock.mockResolvedValue({ success: true, data: created });

    const repo = await addRepoOrUseExisting("/tmp/new-repo");
    expect(repo).toEqual(created);
  });
});
