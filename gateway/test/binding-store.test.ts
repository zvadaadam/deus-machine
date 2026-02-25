import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BindingStore } from "../lib/binding-store";
import type { ChannelBinding } from "../types";

function makeBinding(overrides?: Partial<ChannelBinding>): ChannelBinding {
  return {
    channel: "telegram",
    chatId: "12345",
    workspaceId: "ws-abc",
    sessionId: "sess-xyz",
    workspacePath: "/tmp/workspace",
    repoName: "my-app",
    workspaceName: "happy-cat",
    ...overrides,
  };
}

describe("BindingStore", () => {
  let tmpFile: string;
  let store: BindingStore;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `hive-test-bindings-${Date.now()}.json`);
    store = new BindingStore(tmpFile);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  });

  it("starts empty", () => {
    expect(store.get("telegram", "12345")).toBeUndefined();
    expect(store.all()).toEqual([]);
  });

  it("stores and retrieves a binding", () => {
    const binding = makeBinding();
    store.set(binding);
    expect(store.get("telegram", "12345")).toEqual(binding);
  });

  it("removes a binding", () => {
    store.set(makeBinding());
    expect(store.remove("telegram", "12345")).toBe(true);
    expect(store.get("telegram", "12345")).toBeUndefined();
  });

  it("returns false when removing nonexistent binding", () => {
    expect(store.remove("telegram", "99999")).toBe(false);
  });

  it("lists all bindings", () => {
    store.set(makeBinding({ chatId: "111" }));
    store.set(makeBinding({ chatId: "222" }));
    expect(store.all()).toHaveLength(2);
  });

  it("filters by workspace", () => {
    store.set(makeBinding({ chatId: "111", workspaceId: "ws-1" }));
    store.set(makeBinding({ chatId: "222", workspaceId: "ws-2" }));
    store.set(makeBinding({ chatId: "333", workspaceId: "ws-1" }));
    expect(store.byWorkspace("ws-1")).toHaveLength(2);
    expect(store.byWorkspace("ws-2")).toHaveLength(1);
  });

  it("overwrites existing binding for same chat", () => {
    store.set(makeBinding({ sessionId: "sess-1" }));
    store.set(makeBinding({ sessionId: "sess-2" }));
    expect(store.get("telegram", "12345")?.sessionId).toBe("sess-2");
    expect(store.all()).toHaveLength(1);
  });

  it("persists to disk and reloads", () => {
    const binding = makeBinding();
    store.set(binding);

    // Create a new store from the same file
    const store2 = new BindingStore(tmpFile);
    expect(store2.get("telegram", "12345")).toEqual(binding);
  });

  it("handles missing file gracefully on load", () => {
    const store2 = new BindingStore("/tmp/nonexistent-file-" + Date.now() + ".json");
    expect(store2.all()).toEqual([]);
  });

  it("separates bindings by channel", () => {
    store.set(makeBinding({ channel: "telegram", chatId: "123" }));
    store.set(makeBinding({ channel: "whatsapp", chatId: "123" }));
    expect(store.all()).toHaveLength(2);
    expect(store.get("telegram", "123")).toBeDefined();
    expect(store.get("whatsapp", "123")).toBeDefined();
  });
});
