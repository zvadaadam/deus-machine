import { describe, it, expect } from "vitest";
import {
  LOCAL_NODE_ID,
  CLOUD_NODE_ID,
  workspaceNodeId,
  workspaceRef,
  resourceRef,
  formatRef,
  parseRef,
} from "../../../src/services/node";

describe("node addressing", () => {
  it("routes a cloud workspace to the cloud node, everything else to local", () => {
    // Mirrors resolveWorkspaceTarget: only kind === "cloud" is remote.
    expect(workspaceNodeId({ kind: "cloud" })).toBe(CLOUD_NODE_ID);
    expect(workspaceNodeId({ kind: "worktree" })).toBe(LOCAL_NODE_ID);
    expect(workspaceNodeId({ kind: "local" })).toBe(LOCAL_NODE_ID);
    expect(workspaceNodeId({ kind: null })).toBe(LOCAL_NODE_ID);
    expect(workspaceNodeId({})).toBe(LOCAL_NODE_ID);
  });

  it("addresses a workspace as a node-qualified ref", () => {
    expect(workspaceRef({ id: "ws_1", kind: "cloud" })).toEqual({
      node: "cloud",
      kind: "workspace",
      id: "ws_1",
    });
    expect(workspaceRef({ id: "ws_2" })).toEqual({
      node: "local",
      kind: "workspace",
      id: "ws_2",
    });
  });

  it("round-trips through the canonical string form", () => {
    const ref = resourceRef(CLOUD_NODE_ID, "session", "sess_71a");
    expect(formatRef(ref)).toBe("cloud/session/sess_71a");
    expect(parseRef(formatRef(ref))).toEqual(ref);
  });

  it("keeps an fs path id intact even though it contains slashes", () => {
    const ref = resourceRef(LOCAL_NODE_ID, "fs", "src/app/main.ts");
    expect(formatRef(ref)).toBe("local/fs/src/app/main.ts");
    expect(parseRef(formatRef(ref))).toEqual(ref);
  });

  it("rejects malformed refs and unknown kinds", () => {
    expect(() => parseRef("local")).toThrow();
    expect(() => parseRef("local/session")).toThrow();
    expect(() => parseRef("local/bogus/x")).toThrow();
    expect(() => parseRef("/session/x")).toThrow();
  });
});
