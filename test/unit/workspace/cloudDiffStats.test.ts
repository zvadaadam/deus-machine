/**
 * A cloud workspace's sidebar numbers are read with zeros while its channel is not
 * open or its computer sleeps. The open one's are read again when its channel opens
 * (the connect call returns once it is) and when its computer wakes; the bulk read
 * itself asks only for missing and working workspaces, cloud or not.
 */
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/shared/types";
import type { CloudPresence } from "@/features/workspace/lib/cloudPresence";

vi.mock("@/platform/ws", () => ({ call: vi.fn() }));
const query = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: query,
}));

const { diffStatsToAsk, wokeUp } = await import("@/features/workspace/lib/diffStats");
const { rereadDiffStats, useFileChanges, usePRStatus } =
  await import("@/features/workspace/api/workspace.queries");
const { queryKeys } = await import("@/shared/api/queryKeys");

const row = (
  id: string,
  kind: Workspace["kind"],
  status: NonNullable<Workspace["session_status"]> = "idle"
) =>
  ({
    id,
    kind,
    state: "ready",
    current_session_id: "selected",
    session_status: "idle",
    chats: [
      { id: "selected", status: "idle" },
      { id: "sibling", status },
    ],
  }) as Workspace;

describe("which diff numbers the sidebar asks for", () => {
  const cached =
    (values: Record<string, { additions: number; deletions: number }>) => (id: string) =>
      values[id];

  it("asks for missing numbers and for cached ones while a background chat works", () => {
    const rows = [row("a", "worktree"), row("b", "worktree", "working"), row("c", "worktree")];
    expect(
      diffStatsToAsk(
        rows,
        cached({ b: { additions: 1, deletions: 0 }, c: { additions: 2, deletions: 1 } })
      )
    ).toEqual(["a", "b"]);
  });

  it("takes a cloud workspace's zero as it takes any other number: no polling", () => {
    const rows = [row("cloud-zero", "cloud"), row("cloud-some", "cloud"), row("local", "worktree")];
    const values = cached({
      "cloud-zero": { additions: 0, deletions: 0 },
      "cloud-some": { additions: 4, deletions: 2 },
      local: { additions: 0, deletions: 0 },
    });
    expect(diffStatsToAsk(rows, values)).toEqual([]);
  });

  it("asks for a working cloud workspace, as for any working one", () => {
    const rows = [row("cloud-working", "cloud", "working")];
    expect(
      diffStatsToAsk(rows, cached({ "cloud-working": { additions: 0, deletions: 0 } }))
    ).toEqual(["cloud-working"]);
  });
});

it("polls the workspace's files and pull request while a background chat works", () => {
  for (const status of ["working", "idle", "initializing"] as const) {
    const workspace =
      status === "initializing"
        ? { ...row("workspace", "cloud"), state: status }
        : row("workspace", "worktree", status);
    useFileChanges(workspace, false);
    expect(query.mock.lastCall![0].refetchInterval).toBe(status === "working" ? 5000 : false);
    useFileChanges(workspace, true);
    expect(query.mock.lastCall![0].refetchInterval).toBe(false);
    usePRStatus(workspace.id, { workspace });
    expect(query.mock.lastCall![0].refetchInterval({ state: {} })).toBe(
      status === "working" ? 30_000 : false
    );
  }
});

describe("when the open cloud workspace's computer wakes", () => {
  const open = (workspaceId: string, presence: CloudPresence) => ({ workspaceId, presence });

  it("reads its numbers again when it goes from asleep or waking to awake", () => {
    expect(wokeUp(open("w1", "asleep"), open("w1", "awake"))).toBe(true);
    expect(wokeUp(open("w1", "waking"), open("w1", "awake"))).toBe(true);
  });

  it("does not on any other change", () => {
    // Opened already awake: the connect's answer reads them.
    expect(wokeUp(null, open("w1", "awake"))).toBe(false);
    expect(wokeUp(open("w1", "awake"), open("w1", "awake"))).toBe(false);
    expect(wokeUp(open("w1", "asleep"), open("w1", "waking"))).toBe(false);
    expect(wokeUp(open("w1", "awake"), open("w1", "asleep"))).toBe(false);
    expect(wokeUp(open("w1", "provisioning"), open("w1", "awake"))).toBe(false);
    expect(wokeUp(open("w1", "error"), open("w1", "awake"))).toBe(false);
    // Another workspace opened, awake, after a sleeping one.
    expect(wokeUp(open("w1", "asleep"), open("w2", "awake"))).toBe(false);
    expect(wokeUp(open("w1", "asleep"), null)).toBe(false);
  });
});

describe("opening a cloud workspace", () => {
  it("reads its numbers again (its connect call returned, or its computer woke)", () => {
    const queryClient = { removeQueries: vi.fn(), invalidateQueries: vi.fn() };
    rereadDiffStats(queryClient as never, "w1");
    expect(queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.workspaces.diffStats("w1"),
      exact: true,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["bulk-diff-stats"] });
  });
});
