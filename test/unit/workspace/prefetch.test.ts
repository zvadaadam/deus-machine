import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/shared/api/queryKeys";
import { prefetchWorkspace } from "@/features/workspace/api/prefetch";

const { fetchMessages, fetchById, fetchByWorkspace } = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  fetchById: vi.fn(),
  fetchByWorkspace: vi.fn(),
}));

vi.mock("@/features/session/api/session.service", () => ({
  SessionService: {
    fetchMessages,
    fetchById,
    fetchByWorkspace,
  },
}));

function createQueryClient(options?: { dataUpdatedAt?: number }) {
  return {
    prefetchQuery: vi.fn(() => Promise.resolve()),
    fetchQuery: vi.fn(() => Promise.resolve()),
    getQueryState: vi.fn(() =>
      options?.dataUpdatedAt ? { dataUpdatedAt: options.dataUpdatedAt } : undefined
    ),
  };
}

describe("prefetchWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMessages.mockResolvedValue({ messages: [], has_older: false, has_newer: false });
    fetchById.mockResolvedValue({ id: "session-1", status: "idle" });
    fetchByWorkspace.mockResolvedValue([]);
  });

  it("warms both the restored active tab and current session when they differ", () => {
    const queryClient = createQueryClient();

    prefetchWorkspace(
      queryClient as never,
      {
        id: "ws-1",
        current_session_id: "session-current",
        state: "ready",
      },
      {
        activeSessionId: "session-active",
      }
    );

    expect(queryClient.fetchQuery).not.toHaveBeenCalled();
    expect(queryClient.prefetchQuery).toHaveBeenCalledTimes(5);
    expect(queryClient.prefetchQuery.mock.calls.map(([options]) => options.queryKey)).toEqual([
      queryKeys.sessions.messages("session-active"),
      queryKeys.sessions.detail("session-active"),
      queryKeys.sessions.messages("session-current"),
      queryKeys.sessions.detail("session-current"),
      queryKeys.sessions.byWorkspace("ws-1"),
    ]);
  });

  it("refreshes older cached data when hover prefetch is flagged as likely stale", () => {
    const queryClient = createQueryClient({ dataUpdatedAt: Date.now() - 10_000 });

    prefetchWorkspace(
      queryClient as never,
      {
        id: "ws-1",
        current_session_id: "session-current",
        state: "ready",
      },
      {
        refreshIfCached: true,
      }
    );

    expect(queryClient.prefetchQuery).not.toHaveBeenCalled();
    expect(queryClient.fetchQuery).toHaveBeenCalledTimes(3);
    expect(queryClient.fetchQuery.mock.calls.map(([options]) => options.queryKey)).toEqual([
      queryKeys.sessions.messages("session-current"),
      queryKeys.sessions.detail("session-current"),
      queryKeys.sessions.byWorkspace("ws-1"),
    ]);
  });
});
