import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../agents/session-store";

// ============================================================================
// Tests: SessionStore
// ============================================================================

describe("SessionStore", () => {
  let store: SessionStore<{ name: string; active: boolean }>;

  beforeEach(() => {
    store = new SessionStore();
  });

  // --------------------------------------------------------------------------
  // Basic CRUD
  // --------------------------------------------------------------------------

  describe("basic CRUD", () => {
    it("get returns undefined for missing key", () => {
      expect(store.get("missing")).toBeUndefined();
    });

    it("set + get round-trips a value", () => {
      const state = { name: "test", active: true };
      store.set("s1", state);
      expect(store.get("s1")).toBe(state);
    });

    it("set overwrites an existing value", () => {
      const first = { name: "first", active: true };
      const second = { name: "second", active: false };
      store.set("s1", first);
      store.set("s1", second);
      expect(store.get("s1")).toBe(second);
    });

    it("delete removes the entry", () => {
      store.set("s1", { name: "test", active: true });
      store.delete("s1");
      expect(store.get("s1")).toBeUndefined();
    });

    it("delete is a no-op for missing key", () => {
      expect(() => store.delete("missing")).not.toThrow();
    });

    it("has returns true for existing keys", () => {
      store.set("s1", { name: "test", active: true });
      expect(store.has("s1")).toBe(true);
    });

    it("has returns false for missing keys", () => {
      expect(store.has("missing")).toBe(false);
    });

    it("clear removes all entries", () => {
      store.set("s1", { name: "a", active: true });
      store.set("s2", { name: "b", active: true });
      store.clear();
      expect(store.has("s1")).toBe(false);
      expect(store.has("s2")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Ownership guard (owns)
  // --------------------------------------------------------------------------

  describe("owns", () => {
    it("returns true when no session exists for the id", () => {
      const ref = { name: "orphan", active: true };
      expect(store.owns("missing", ref)).toBe(true);
    });

    it("returns true when the stored session is the same reference", () => {
      const ref = { name: "test", active: true };
      store.set("s1", ref);
      expect(store.owns("s1", ref)).toBe(true);
    });

    it("returns false when the stored session is a different reference", () => {
      const oldRef = { name: "old", active: true };
      const newRef = { name: "new", active: true };
      store.set("s1", newRef);
      expect(store.owns("s1", oldRef)).toBe(false);
    });

    it("returns false for structurally equal but referentially different objects", () => {
      const ref1 = { name: "same", active: true };
      const ref2 = { name: "same", active: true };
      store.set("s1", ref1);
      // ref2 has the same data but is a different object — owns should return false
      expect(store.owns("s1", ref2)).toBe(false);
    });

    it("returns true after delete (no current session to protect)", () => {
      const ref = { name: "test", active: true };
      store.set("s1", ref);
      store.delete("s1");
      expect(store.owns("s1", ref)).toBe(true);
    });
  });
});
