import { describe, expect, test } from "bun:test";
import { isInteractive } from "../src/engine/snapshot/filter.js";
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
