import { describe, expect, test } from "bun:test";
import {
  filterInteractive,
  filterTree,
  findInTree,
  isInteractive,
} from "../src/engine/snapshot/filter.js";
import type { AccessibilityNode } from "../src/engine/types.js";

function n(overrides: Partial<AccessibilityNode> & { type: string }): AccessibilityNode {
  return {
    role: "AXAny",
    label: undefined,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    center: { x: 5, y: 5 },
    enabled: true,
    traits: [],
    children: [],
    ...overrides,
  };
}

describe("isInteractive", () => {
  test("recognizes built-in interactive types", () => {
    expect(isInteractive(n({ type: "Button" }))).toBe(true);
    expect(isInteractive(n({ type: "TextField" }))).toBe(true);
    expect(isInteractive(n({ type: "Cell" }))).toBe(true);
  });

  test("uses 'interactive' trait fallback", () => {
    expect(isInteractive(n({ type: "Group", traits: ["interactive"] }))).toBe(true);
  });

  test("ignores non-interactive types without trait", () => {
    expect(isInteractive(n({ type: "StaticText" }))).toBe(false);
  });
});

describe("filterInteractive", () => {
  test("only returns enabled interactive nodes, flattened", () => {
    const tree: AccessibilityNode[] = [
      n({
        type: "Group",
        children: [
          n({ type: "Button", label: "Enabled" }),
          n({ type: "Button", label: "Disabled", enabled: false }),
          n({ type: "StaticText", label: "ignore me" }),
        ],
      }),
      n({ type: "TextField" }),
    ];

    const out = filterInteractive(tree);
    expect(out).toHaveLength(2);
    expect(out[0]!.label).toBe("Enabled");
    expect(out[1]!.type).toBe("TextField");
  });
});

describe("findInTree", () => {
  test("DFS finds the first matching node", () => {
    const tree: AccessibilityNode[] = [
      n({
        type: "Group",
        children: [n({ type: "Button", identifier: "target" })],
      }),
    ];
    const found = findInTree(tree, (x) => x.identifier === "target");
    expect(found?.type).toBe("Button");
  });

  test("returns null when nothing matches", () => {
    expect(findInTree([n({ type: "Button" })], (x) => x.identifier === "nope")).toBeNull();
  });
});

describe("filterTree", () => {
  test("walks the whole tree", () => {
    const tree: AccessibilityNode[] = [
      n({ type: "A", children: [n({ type: "A", children: [n({ type: "A" })] })] }),
    ];
    expect(filterTree(tree, (x) => x.type === "A")).toHaveLength(3);
  });
});
