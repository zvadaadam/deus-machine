import { describe, expect, test } from "bun:test";
import { RefMap } from "../src/engine/snapshot/refs.js";
import type { RefEntry } from "../src/engine/types.js";

function entry(ref: string, label: string): RefEntry {
  return {
    ref,
    type: "Button",
    label,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    center: { x: 0, y: 0 },
    enabled: true,
    traits: [],
  };
}

describe("RefMap", () => {
  test("nextRef increments from startCounter", () => {
    const m = new RefMap(3);
    expect(m.nextRef()).toBe("@e4");
    expect(m.nextRef()).toBe("@e5");
    expect(m.getNextCounter()).toBe(5);
  });

  test("starts at @e1 when no counter given", () => {
    const m = new RefMap();
    expect(m.nextRef()).toBe("@e1");
  });

  test("set + resolve roundtrip", () => {
    const m = new RefMap(0);
    const ref = m.nextRef();
    m.set(entry(ref, "Hi"));
    expect(m.resolve(ref)?.label).toBe("Hi");
  });

  test("resolve unknown ref → undefined", () => {
    expect(new RefMap(0).resolve("@e42")).toBeUndefined();
  });

  test("entries returns everything stored", () => {
    const m = new RefMap(0);
    m.set(entry(m.nextRef(), "A"));
    m.set(entry(m.nextRef(), "B"));
    expect(m.entries().map((e) => e.label)).toEqual(["A", "B"]);
  });

  test("clear drops entries but keeps counter", () => {
    const m = new RefMap(0);
    m.set(entry(m.nextRef(), "A"));
    m.clear();
    expect(m.entries()).toHaveLength(0);
    expect(m.getNextCounter()).toBe(1);
  });
});
