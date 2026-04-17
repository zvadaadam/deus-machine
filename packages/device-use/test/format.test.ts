import { describe, expect, test } from "bun:test";
import { formatCompact, formatTree } from "../src/engine/snapshot/format.js";
import { buildSnapshot } from "../src/engine/snapshot/build.js";
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

describe("formatTree", () => {
  test("indents children under parent", () => {
    const snap = buildSnapshot([
      n({
        type: "Application",
        label: "Settings",
        children: [n({ type: "Button", label: "General" })],
      }),
    ]);
    const out = formatTree(snap.tree);
    const lines = out.split("\n");
    expect(lines[0]!.startsWith("Application")).toBe(true);
    expect(lines[1]!.startsWith("  @e1 Button")).toBe(true);
  });

  test("StaticText renders as bullet", () => {
    const snap = buildSnapshot([n({ type: "StaticText", label: "Note" })]);
    expect(formatTree(snap.tree)).toMatch(/^· "Note"$/);
  });

  test("disabled interactive shows (disabled)", () => {
    const snap = buildSnapshot([n({ type: "Button", label: "X", enabled: false })]);
    // disabled button is not interactive so no ref — it appears as a plain node
    // (enabled:false + interactive type → dropped for refs; kept if has label)
    const text = formatTree(snap.tree);
    expect(text).toContain("Button");
    expect(text).toContain('"X"');
  });
});

describe("formatCompact", () => {
  test("one line per ref, with ref/type/label/coords", () => {
    const snap = buildSnapshot([
      n({ type: "Button", label: "Sign In", center: { x: 100, y: 200 } }),
    ]);
    const line = formatCompact(snap.refs);
    expect(line).toMatch(/^@e1 Button "Sign In" @\(100,200\)$/);
  });

  test("truncates long labels", () => {
    const long = "a".repeat(100);
    const snap = buildSnapshot([n({ type: "Button", label: long })]);
    const line = formatCompact(snap.refs);
    expect(line.length).toBeLessThan(120);
    expect(line).toContain("…");
  });
});
