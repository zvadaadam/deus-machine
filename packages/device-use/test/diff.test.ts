import { describe, expect, test } from "bun:test";
import { diffSnapshots } from "../src/engine/snapshot/diff.js";
import type { RefEntry } from "../src/engine/types.js";

function e(overrides: Partial<Omit<RefEntry, "ref">> & { type: string }): Omit<RefEntry, "ref"> {
  return {
    frame: { x: 0, y: 0, width: 10, height: 10 },
    center: { x: 5, y: 5 },
    enabled: true,
    traits: [],
    ...overrides,
  };
}

describe("diffSnapshots", () => {
  test("detects added elements", () => {
    const diff = diffSnapshots(
      [e({ type: "Button", label: "A" })],
      [e({ type: "Button", label: "A" }), e({ type: "Button", label: "B" })]
    );
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.label).toBe("B");
  });

  test("detects removed elements", () => {
    const diff = diffSnapshots(
      [e({ type: "Button", label: "A" }), e({ type: "Button", label: "B" })],
      [e({ type: "Button", label: "A" })]
    );
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.label).toBe("B");
  });

  test("detects value changes", () => {
    const diff = diffSnapshots(
      [e({ type: "TextField", label: "Email", value: "" })],
      [e({ type: "TextField", label: "Email", value: "foo@bar" })]
    );
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.changes?.[0]).toContain("value:");
  });

  test("counts unchanged", () => {
    const diff = diffSnapshots(
      [e({ type: "Button", label: "A" })],
      [e({ type: "Button", label: "A" })]
    );
    expect(diff.unchanged).toBe(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  test("ignores small position drift (<= 2px)", () => {
    const diff = diffSnapshots(
      [e({ type: "Button", label: "A", center: { x: 50, y: 50 } })],
      [e({ type: "Button", label: "A", center: { x: 51, y: 49 } })]
    );
    expect(diff.unchanged).toBe(1);
    expect(diff.changed).toHaveLength(0);
  });

  test("flags large position drift", () => {
    const diff = diffSnapshots(
      [e({ type: "Button", label: "A", center: { x: 50, y: 50 } })],
      [e({ type: "Button", label: "A", center: { x: 100, y: 100 } })]
    );
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.changes?.[0]).toContain("position:");
  });

  test("pairs duplicates by identity key (type + id/label)", () => {
    const diff = diffSnapshots(
      [e({ type: "Cell", label: "Item" }), e({ type: "Cell", label: "Item" })],
      [e({ type: "Cell", label: "Item" })]
    );
    expect(diff.removed).toHaveLength(1);
    expect(diff.unchanged).toBe(1);
  });
});
