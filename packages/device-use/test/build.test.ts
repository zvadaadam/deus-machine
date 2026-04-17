import { describe, expect, test } from "bun:test";
import { buildSnapshot } from "../src/engine/snapshot/build.js";
import { RefMap } from "../src/engine/snapshot/refs.js";
import type { AccessibilityNode } from "../src/engine/types.js";

function n(overrides: Partial<AccessibilityNode> & { type: string }): AccessibilityNode {
  return {
    role: "AXAny",
    frame: { x: 0, y: 0, width: 10, height: 10 },
    center: { x: 5, y: 5 },
    enabled: true,
    traits: [],
    children: [],
    ...overrides,
  };
}

describe("buildSnapshot", () => {
  test("flat input produces a flat tree (no extra nesting)", () => {
    const snap = buildSnapshot([
      n({ type: "Button", label: "A" }),
      n({ type: "Button", label: "B" }),
    ]);
    expect(snap.tree).toHaveLength(2);
    expect(snap.refs.map((r) => r.ref)).toEqual(["@e1", "@e2"]);
    expect(snap.counts).toEqual({ total: 2, interactive: 2 });
  });

  test("assigns refs only to interactive nodes", () => {
    const snap = buildSnapshot([
      n({
        type: "Group",
        children: [
          n({ type: "StaticText", label: "Email" }),
          n({ type: "TextField", identifier: "email" }),
        ],
      }),
    ]);
    expect(snap.refs.map((r) => r.identifier)).toEqual(["email"]);
    const group = snap.tree[0]!;
    expect(group.ref).toBeUndefined();
    const staticText = group.children![0]!;
    const textField = group.children![1]!;
    expect(staticText.ref).toBeUndefined();
    expect(textField.ref).toBe("@e1");
    expect(textField.interactive).toBe(true);
  });

  test("preserves parent chain for nested interactive nodes", () => {
    const snap = buildSnapshot([
      n({
        type: "Application",
        label: "Settings",
        children: [
          n({
            type: "Group",
            children: [n({ type: "Button", label: "iOS Version" })],
          }),
        ],
      }),
    ]);
    const app = snap.tree[0]!;
    expect(app.type).toBe("Application");
    const group = app.children![0]!;
    expect(group.type).toBe("Group");
    const button = group.children![0]!;
    expect(button.ref).toBe("@e1");
  });

  test("interactiveOnly drops context-free branches", () => {
    const snap = buildSnapshot(
      [
        n({
          type: "Group",
          children: [n({ type: "StaticText", label: "Just some text" })],
        }),
        n({ type: "Button", label: "Tappable" }),
      ],
      { interactiveOnly: true }
    );
    // first Group has no interactive descendants → pruned entirely
    expect(snap.tree).toHaveLength(1);
    expect(snap.tree[0]!.label).toBe("Tappable");
  });

  test("interactiveOnly keeps ancestors of interactive leaves", () => {
    const snap = buildSnapshot(
      [
        n({
          type: "Application",
          children: [
            n({
              type: "Group",
              children: [
                n({ type: "StaticText", label: "Email" }),
                n({ type: "TextField", identifier: "email" }),
              ],
            }),
          ],
        }),
      ],
      { interactiveOnly: true }
    );
    const app = snap.tree[0]!;
    const group = app.children![0]!;
    // Label-only StaticText is dropped under interactiveOnly
    expect(group.children).toHaveLength(1);
    expect(group.children![0]!.ref).toBe("@e1");
  });

  test("counts are accurate across a larger tree", () => {
    const snap = buildSnapshot([
      n({
        type: "Application",
        children: [
          n({ type: "Button", label: "A" }),
          n({ type: "Heading", label: "Section" }),
          n({
            type: "Group",
            children: [
              n({ type: "Button", label: "B" }),
              n({ type: "Button", label: "C", enabled: false }),
            ],
          }),
        ],
      }),
    ]);
    expect(snap.counts.total).toBe(6);
    // The disabled button is non-interactive, so only 2 refs
    expect(snap.counts.interactive).toBe(2);
    expect(snap.refs.map((r) => r.label)).toEqual(["A", "B"]);
  });

  test("shares a RefMap across multiple buildSnapshot calls", () => {
    const refMap = new RefMap(0);
    const first = buildSnapshot([n({ type: "Button", label: "A" })], { refMap });
    const second = buildSnapshot([n({ type: "Button", label: "B" })], { refMap });
    expect(first.refs[0]!.ref).toBe("@e1");
    expect(second.refs[0]!.ref).toBe("@e2");
    expect(refMap.resolve("@e1")?.label).toBe("A");
    expect(refMap.resolve("@e2")?.label).toBe("B");
  });

  test("startCounter offsets the first ref", () => {
    const snap = buildSnapshot([n({ type: "Button", label: "A" })], {
      startCounter: 100,
    });
    expect(snap.refs[0]!.ref).toBe("@e101");
  });

  test("visible-first: off-screen interactive nodes do not get refs", () => {
    const snap = buildSnapshot([
      n({
        type: "Application",
        frame: { x: 0, y: 0, width: 402, height: 874 },
        center: { x: 201, y: 437 },
        children: [
          n({ type: "Button", label: "OnScreen", center: { x: 100, y: 100 } }),
          n({
            type: "Button",
            label: "BelowTheFold",
            center: { x: 100, y: 2000 },
            frame: { x: 0, y: 1950, width: 200, height: 44 },
          }),
          n({
            type: "Button",
            label: "RightOfScreen",
            center: { x: 900, y: 100 },
            frame: { x: 800, y: 80, width: 200, height: 44 },
          }),
        ],
      }),
    ]);
    const labels = snap.refs.map((r) => r.label);
    expect(labels).toEqual(["OnScreen"]);
  });

  test("includeHidden: off-screen nodes DO get refs when asked", () => {
    const snap = buildSnapshot(
      [
        n({
          type: "Application",
          frame: { x: 0, y: 0, width: 402, height: 874 },
          center: { x: 201, y: 437 },
          children: [
            n({ type: "Button", label: "OnScreen", center: { x: 100, y: 100 } }),
            n({
              type: "Button",
              label: "Offscreen",
              center: { x: 100, y: 2000 },
              frame: { x: 0, y: 1950, width: 200, height: 44 },
            }),
          ],
        }),
      ],
      { includeHidden: true }
    );
    expect(snap.refs.map((r) => r.label)).toEqual(["OnScreen", "Offscreen"]);
  });

  test("visible-first passes-through when no Application root frame is available", () => {
    // Bare button list, no Application wrapper → no screen bounds known → don't filter
    const snap = buildSnapshot([n({ type: "Button", label: "A", center: { x: 9999, y: 9999 } })]);
    expect(snap.refs).toHaveLength(1);
  });
});
