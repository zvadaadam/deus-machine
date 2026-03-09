import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore, workspaceActions } from "@/features/workspace/store/workspaceStore";

describe("workspaceStore", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      selectedWorkspaceId: null,
      diffStats: {},
    });
  });

  it("tracks only the selected workspace id", () => {
    workspaceActions.selectWorkspace("ws-123");

    const state = useWorkspaceStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-123");
    expect("selectedWorkspace" in state).toBe(false);
  });

  it("clears the selection without touching diff stats", () => {
    workspaceActions.selectWorkspace("ws-123");
    workspaceActions.setDiffStats("ws-123", { additions: 4, deletions: 2 });

    workspaceActions.clearSelection();

    expect(useWorkspaceStore.getState()).toMatchObject({
      selectedWorkspaceId: null,
      diffStats: {
        "ws-123": { additions: 4, deletions: 2 },
      },
    });
  });

  it("merges bulk diff stats by workspace id", () => {
    workspaceActions.setDiffStats("ws-1", { additions: 1, deletions: 0 });
    workspaceActions.setMultipleDiffStats({
      "ws-2": { additions: 5, deletions: 3 },
      "ws-3": { additions: 2, deletions: 2 },
    });

    expect(useWorkspaceStore.getState().diffStats).toEqual({
      "ws-1": { additions: 1, deletions: 0 },
      "ws-2": { additions: 5, deletions: 3 },
      "ws-3": { additions: 2, deletions: 2 },
    });
  });
});
