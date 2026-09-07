import { describe, expect, test, mock } from "bun:test";
import type { AccessibilityNode, SimBridgeRequest } from "../src/engine/types.js";
import { SimBridgeError } from "../src/engine/errors.js";

// `mock.module` registers the mock before the (dynamic) import below resolves.
// The factories close over the module-scoped `tapped` / `tree` bindings so each
// test can reset and re-seed them by reassigning those `let`s.
let tapped: SimBridgeRequest[] = [];
let tree: AccessibilityNode[] = [];

mock.module("../src/engine/simbridge.js", () => ({
  callSimBridge: async (cmd: SimBridgeRequest) => {
    tapped.push(cmd);
    return { success: true, command: cmd.command };
  },
}));

mock.module("../src/engine/accessibility.js", () => ({
  fetchAccessibilityTree: async () => tree,
}));

const { tapEntry, tapByLabel } = await import("../src/engine/interaction.js");

/** Minimal AccessibilityNode builder — only the fields interaction.ts reads. */
function n(node: Partial<AccessibilityNode> & { type: string }): AccessibilityNode {
  return {
    role: "AXAny",
    label: undefined,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    center: { x: 5, y: 5 },
    enabled: true,
    traits: [],
    children: [],
    ...node,
  };
}

describe("tapEntry — label branch", () => {
  test("single match by label taps that element", async () => {
    tapped = [];
    const cell = n({ type: "Cell", label: "Done", center: { x: 50, y: 50 } });
    tree = [n({ type: "Window", children: [cell] })];

    await tapEntry("udid-1", { identifier: undefined, label: "Done", center: { x: 50, y: 50 } });
    expect(tapped).toHaveLength(1);
    expect(tapped[0]).toEqual({ command: "tap", udid: "udid-1", x: 50, y: 50 });
  });

  test("duplicate labels tap the ref's element (by center), not the first DFS match", async () => {
    tapped = [];
    const cellA = n({ type: "Cell", label: "Edit", center: { x: 10, y: 10 } }); // DFS-first
    const cellB = n({ type: "Cell", label: "Edit", center: { x: 90, y: 200 } }); // ref's element
    tree = [n({ type: "Window", children: [cellA, cellB] })];

    await tapEntry("udid-1", {
      identifier: undefined,
      label: "Edit",
      center: { x: 90, y: 200 },
    });

    expect(tapped).toHaveLength(1);
    expect(tapped[0]).toEqual({ command: "tap", udid: "udid-1", x: 90, y: 200 });
  });

  test("no match by label throws ELEMENT_NOT_FOUND", async () => {
    tapped = [];
    tree = [n({ type: "Window", children: [n({ type: "Button", label: "Save" })] })];

    await expect(
      tapEntry("udid-1", { identifier: undefined, label: "Missing", center: { x: 1, y: 1 } })
    ).rejects.toBeInstanceOf(SimBridgeError);
    expect(tapped).toHaveLength(0);
  });
});

describe("tapByLabel — no-hint path (CLI callers)", () => {
  test("without a hint, multiple matches preserve the first-DFS-match behavior", async () => {
    tapped = [];
    const a = n({ type: "Cell", label: "Edit", center: { x: 10, y: 10 } });
    const b = n({ type: "Cell", label: "Edit", center: { x: 90, y: 200 } });
    tree = [n({ type: "Window", children: [a, b] })];

    await tapByLabel("udid-1", "Edit");
    expect(tapped[0]).toEqual({ command: "tap", udid: "udid-1", x: 10, y: 10 });
  });
});

describe("tapEntry — identifier branch", () => {
  test("duplicate ids disambiguate by the ref's center hint", async () => {
    tapped = [];
    const a = n({ type: "Button", identifier: "dup", center: { x: 0, y: 0 } });
    const b = n({ type: "Button", identifier: "dup", center: { x: 50, y: 50 } });
    tree = [n({ type: "Window", children: [a, b] })];

    await tapEntry("udid-1", { identifier: "dup", label: undefined, center: { x: 50, y: 50 } });
    expect(tapped[0]).toEqual({ command: "tap", udid: "udid-1", x: 50, y: 50 });
  });
});
