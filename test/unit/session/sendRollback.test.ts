/**
 * The failed-send rollback, and the one thing it must not do: overwrite the
 * status the backend already pushed.
 *
 * `handleSendMessage` writes the session's outcome and calls `invalidate`
 * BEFORE it throws, so a rejected send's q:snapshot reaches the cache ahead of
 * the `q:command_ack` that rejects it. Restoring the pre-send snapshot on top
 * of that is older data winning, and with `staleTime: Infinity` nothing ever
 * corrects it.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { SendRejectedError, rollbackSendStatus } from "@/features/session/lib/sendRollback";

const BY_REPO = ["workspaces", "by-repo", "active"] as const;

/** One RepoGroup-shaped entry — only `session_status` matters here. */
const group = (status: string) => [
  { repo_id: "r1", workspaces: [{ id: "w1", current_session_id: "s1", session_status: status }] },
];

describe("rollbackSendStatus", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  describe("a rejection the SERVER answered", () => {
    // Both flavors travel as SendRejectedError, and both must refetch.
    // "error"    — admission failed; the backend persisted + pushed 'error'.
    // "working"  — turnActive; the backend left the status alone, and alone
    //              means another client's turn IS running.
    it.each([
      ["admission failed (backend pushed 'error')", "error"],
      ["turnActive (another client's turn is running)", "working"],
    ])("refetches instead of restoring — %s", (_label, pushedStatus) => {
      // Pre-send: the sidebar showed idle. That is the snapshot onMutate took.
      const snapshot: Array<[readonly unknown[], unknown]> = [[BY_REPO, group("idle")]];
      // The backend's push landed first, ahead of the rejecting ack.
      queryClient.setQueryData(BY_REPO, group(pushedStatus));

      rollbackSendStatus(queryClient, new SendRejectedError("nope"), snapshot);

      // The pushed status survives — the pre-send "idle" did not overwrite it.
      expect(queryClient.getQueryData(BY_REPO)).toEqual(group(pushedStatus));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workspaces", "by-repo"] });
    });

    it("invalidates with a PREFIX that matches the state-suffixed keys", () => {
      queryClient.setQueryData(BY_REPO, group("error"));
      queryClient.setQueryData(["workspaces", "by-repo", "archived"], group("error"));

      rollbackSendStatus(queryClient, new SendRejectedError("nope"), [[BY_REPO, group("idle")]]);

      // A key of ["workspaces","by-repo",undefined] would match NEITHER of
      // these; the prefix must match both.
      const matched = queryClient
        .getQueryCache()
        .findAll({ queryKey: invalidateSpy.mock.calls[0]?.[0]?.queryKey })
        .map((q) => q.queryKey);
      expect(matched).toHaveLength(2);
    });
  });

  describe("a transport failure", () => {
    it("restores the snapshot — nothing was pushed, and a refetch has nowhere to go", () => {
      const snapshot: Array<[readonly unknown[], unknown]> = [[BY_REPO, group("idle")]];
      queryClient.setQueryData(BY_REPO, group("working")); // the optimistic paint

      rollbackSendStatus(queryClient, new Error("WebSocket disconnected"), snapshot);

      expect(queryClient.getQueryData(BY_REPO)).toEqual(group("idle"));
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it("falls back to a refetch when there was no snapshot to restore", () => {
      rollbackSendStatus(queryClient, new Error("WebSocket disconnected"), []);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workspaces", "by-repo"] });
    });
  });
});
