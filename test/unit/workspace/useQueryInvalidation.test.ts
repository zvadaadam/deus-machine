import { describe, expect, it, vi, beforeEach } from "vitest";
import { dispatchInvalidation } from "@/features/workspace/hooks/useQueryInvalidation";
import { queryKeys } from "@/shared/api/queryKeys";

function createMockQueryClient() {
  return {
    invalidateQueries: vi.fn(),
  };
}

describe("dispatchInvalidation", () => {
  let queryClient: ReturnType<typeof createMockQueryClient>;

  beforeEach(() => {
    queryClient = createMockQueryClient();
  });

  it("invalidates workspaces cache with predicate that excludes expensive subkeys", () => {
    dispatchInvalidation(queryClient as any, ["workspaces"]);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    const call = queryClient.invalidateQueries.mock.calls[0][0];
    expect(call.queryKey).toEqual(queryKeys.workspaces.all);
    expect(call.predicate).toBeDefined();

    // Cheap queries SHOULD be invalidated
    const byRepoQuery = { queryKey: ["workspaces", "by-repo", "repo-1"] };
    expect(call.predicate(byRepoQuery)).toBe(true);

    const detailQuery = { queryKey: ["workspaces", "detail", "ws-1"] };
    expect(call.predicate(detailQuery)).toBe(true);

    // Expensive queries should NOT be invalidated
    const diffStatsQuery = { queryKey: ["workspaces", "diff-stats", "ws-1"] };
    expect(call.predicate(diffStatsQuery)).toBe(false);

    const diffFilesQuery = { queryKey: ["workspaces", "diff-files", "ws-1"] };
    expect(call.predicate(diffFilesQuery)).toBe(false);

    const prStatusQuery = { queryKey: ["workspaces", "pr-status", "ws-1"] };
    expect(call.predicate(prStatusQuery)).toBe(false);

    const manifestQuery = { queryKey: ["workspaces", "manifest", "ws-1"] };
    expect(call.predicate(manifestQuery)).toBe(false);
  });

  it("invalidates stats cache for 'stats' resource", () => {
    dispatchInvalidation(queryClient as any, ["stats"]);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.stats.all,
    });
  });

  it("handles multiple resources in a single call", () => {
    dispatchInvalidation(queryClient as any, ["workspaces", "stats"]);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    // Workspaces call includes a predicate
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.workspaces.all })
    );
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.stats.all,
    });
  });

  it("ignores unknown resources without error", () => {
    dispatchInvalidation(queryClient as any, ["unknown_resource"]);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it("does nothing for empty resources array", () => {
    dispatchInvalidation(queryClient as any, []);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates sessions with predicate that excludes messages", () => {
    dispatchInvalidation(queryClient as any, ["sessions"]);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    const call = queryClient.invalidateQueries.mock.calls[0][0];
    expect(call.queryKey).toEqual(queryKeys.sessions.all);
    expect(call.predicate).toBeDefined();

    // The predicate should INCLUDE session detail queries
    const sessionDetailQuery = {
      queryKey: ["sessions", "detail", "session-123"],
    };
    expect(call.predicate(sessionDetailQuery)).toBe(true);

    // The predicate should INCLUDE session list queries
    const sessionListQuery = {
      queryKey: ["sessions", "by-workspace", "ws-1"],
    };
    expect(call.predicate(sessionListQuery)).toBe(true);

    // The predicate should EXCLUDE message queries
    const messageQuery = {
      queryKey: ["sessions", "messages", "session-123"],
    };
    expect(call.predicate(messageQuery)).toBe(false);
  });

  it("handles mixed known and unknown resources", () => {
    dispatchInvalidation(queryClient as any, ["stats", "unknown", "workspaces"]);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.stats.all,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.workspaces.all })
    );
  });
});
