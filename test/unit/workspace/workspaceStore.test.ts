import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/features/workspace/store/workspaceStore";

describe("workspaceStore", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      selectedWorkspaceId: null,
    });
  });

  it("tracks only the selected workspace id", () => {
    useWorkspaceStore.getState().selectWorkspace("ws-123");

    const state = useWorkspaceStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-123");
    expect("selectedWorkspace" in state).toBe(false);
  });

  it("clears the selected workspace", () => {
    useWorkspaceStore.getState().selectWorkspace("ws-123");
    useWorkspaceStore.getState().selectWorkspace(null);

    expect(useWorkspaceStore.getState().selectedWorkspaceId).toBeNull();
  });
});
