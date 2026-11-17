import { describe, it, expect } from "vitest";
import { LOCAL_NODE_ID, CLOUD_NODE_ID, workspaceNodeId } from "../../../src/services/node";

describe("node addressing", () => {
  it("routes a cloud workspace to the cloud node, everything else to local", () => {
    // Mirrors resolveWorkspaceTarget: only kind === "cloud" is remote.
    expect(workspaceNodeId({ kind: "cloud" })).toBe(CLOUD_NODE_ID);
    expect(workspaceNodeId({ kind: "worktree" })).toBe(LOCAL_NODE_ID);
    expect(workspaceNodeId({ kind: "local" })).toBe(LOCAL_NODE_ID);
    expect(workspaceNodeId({ kind: null })).toBe(LOCAL_NODE_ID);
    expect(workspaceNodeId({})).toBe(LOCAL_NODE_ID);
  });
});
