import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushWorkspaceLayoutStorage,
  resolveWorkspaceTabs,
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";
import { DEFAULT_NEW_TAB_ID } from "@/features/workspace-tabs/types";
import { getTerminalInitialCommand } from "@/features/terminal/store/terminalTaskStore";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("workspaceLayoutStore", () => {
  beforeEach(() => {
    workspaceLayoutActions.resetAll();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults a fresh workspace to a single New Tab", () => {
    const layout = workspaceLayoutActions.getLayout("ws-fresh");
    const resolved = resolveWorkspaceTabs(layout);

    expect(resolved.tabs).toHaveLength(1);
    expect(resolved.activeTabId).toBe(DEFAULT_NEW_TAB_ID);
    expect(resolved.activeTab).toEqual({ id: DEFAULT_NEW_TAB_ID, kind: "new-tab" });
  });

  it("opens a dedicated file tab when opening a file in files target and queues reveal state", () => {
    workspaceLayoutActions.openFileInContent("ws-123", "./src/demo.tsx", "files");

    const layout = useWorkspaceLayoutStore.getState().getLayout("ws-123");
    const { activeTab } = resolveWorkspaceTabs(layout);

    expect(activeTab.kind).toBe("file");
    if (activeTab.kind === "file") {
      expect(activeTab.path).toBe("src/demo.tsx");
    }
    expect(layout.selectedFilePath).toBe("src/demo.tsx");
    expect(layout.panelMode).toBe("split");
    expect(layout.pendingFileNavigation).toMatchObject({
      path: "src/demo.tsx",
      target: "files",
    });
    expect(layout.pendingFileNavigation?.requestId).toEqual(expect.any(String));
  });

  it("deduplicates file tabs for the same path and allows multiple distinct file tabs", () => {
    const firstId = workspaceLayoutActions.openFileTab("ws-files", "src/a.ts");
    const secondId = workspaceLayoutActions.openFileTab("ws-files", "src/b.ts");
    const duplicateId = workspaceLayoutActions.openFileTab("ws-files", "./src/a.ts");

    const layout = workspaceLayoutActions.getLayout("ws-files");
    expect(duplicateId).toBe(firstId);
    expect(layout.workspaceTabs).toHaveLength(2);
    expect(layout.activeWorkspaceTabId).toBe(firstId);
    expect(secondId).not.toBe(firstId);
  });

  it("issues a fresh reveal request even when reopening the same file in changes", () => {
    workspaceLayoutActions.openFileInContent("ws-123", "src/demo.tsx", "changes");
    const firstRequestId = useWorkspaceLayoutStore.getState().getLayout("ws-123")
      .pendingFileNavigation?.requestId;

    workspaceLayoutActions.openFileInContent("ws-123", "src/demo.tsx", "changes");
    const secondLayout = useWorkspaceLayoutStore.getState().getLayout("ws-123");
    const { activeTab, tabs } = resolveWorkspaceTabs(secondLayout);

    expect(activeTab.kind).toBe("changes");
    expect(tabs.filter((t) => t.kind === "changes")).toHaveLength(1);
    expect(secondLayout.pendingFileNavigation).toMatchObject({
      path: "src/demo.tsx",
      target: "changes",
    });
    expect(secondLayout.pendingFileNavigation?.requestId).not.toBe(firstRequestId);
  });

  it("ignores invalid traversal paths", () => {
    workspaceLayoutActions.openFileInContent("ws-123", "../outside.ts", "files");

    expect(useWorkspaceLayoutStore.getState().layouts["ws-123"]).toBeUndefined();
  });

  it("supports multiple terminal and browser tabs side-by-side while deduplicating singletons", () => {
    const term1 = workspaceLayoutActions.openTerminalTab("ws-multi", {
      title: "Dev server",
      initialCommand: "bun run dev",
    });
    const term2 = workspaceLayoutActions.openTerminalTab("ws-multi");
    const browser1 = workspaceLayoutActions.openBrowserTab("ws-multi", "http://localhost:1420");
    const browser2 = workspaceLayoutActions.openBrowserTab("ws-multi", "https://example.com");
    const changes1 = workspaceLayoutActions.openToolTab("ws-multi", "changes");
    const changes2 = workspaceLayoutActions.openToolTab("ws-multi", "changes");

    const layout = workspaceLayoutActions.getLayout("ws-multi");
    expect(changes2).toBe(changes1);
    expect(getTerminalInitialCommand(term1)).toBe("bun run dev");
    expect(layout.workspaceTabs.map((t) => t.kind)).toEqual([
      "terminal",
      "terminal",
      "browser",
      "browser",
      "changes",
    ]);
    expect(term1).not.toBe(term2);
    expect(browser1).not.toBe(browser2);
  });

  it("closing the last tab creates a fresh New Tab and clears terminal commands", () => {
    const termId = workspaceLayoutActions.openTerminalTab("ws-close", {
      title: "Build",
      initialCommand: "bun run build",
    });
    expect(getTerminalInitialCommand(termId)).toBe("bun run build");

    workspaceLayoutActions.closeWorkspaceTab("ws-close", termId);

    expect(getTerminalInitialCommand(termId)).toBeUndefined();
    const { tabs, activeTab } = resolveWorkspaceTabs(workspaceLayoutActions.getLayout("ws-close"));
    expect(tabs).toHaveLength(1);
    expect(activeTab.kind).toBe("new-tab");
  });

  it("drops an empty launcher New Tab when jumping to an already-open singleton tool", () => {
    const changesId = workspaceLayoutActions.openToolTab("ws-dedup", "changes");
    const newTabId = workspaceLayoutActions.addNewTab("ws-dedup");
    expect(workspaceLayoutActions.getLayout("ws-dedup").workspaceTabs).toHaveLength(2);

    const focusedId = workspaceLayoutActions.openToolTab("ws-dedup", "changes", {
      replaceTabId: newTabId,
    });
    const layout = workspaceLayoutActions.getLayout("ws-dedup");
    expect(focusedId).toBe(changesId);
    expect(layout.workspaceTabs).toHaveLength(1);
    expect(layout.activeWorkspaceTabId).toBe(changesId);
  });

  it("changes views without losing tool or session state or touching another workspace", () => {
    workspaceLayoutActions.openBrowserTab("first", "http://localhost:3000");
    workspaceLayoutActions.setSelectedFilePath("first", "README.md");
    workspaceLayoutActions.setChatTabState("first", ["claude", "codex"], "codex");
    workspaceLayoutActions.openTerminalTab("first", { title: "Dev server" });
    workspaceLayoutActions.setPanelMode("second", "content");
    const before = workspaceLayoutActions.getLayout("first");

    for (const mode of ["chat", "content", "split"] as const) {
      workspaceLayoutActions.setPanelMode("first", mode);
      expect(workspaceLayoutActions.getLayout("first")).toEqual({ ...before, panelMode: mode });
      expect(workspaceLayoutActions.getLayout("second").panelMode).toBe("content");
    }
  });

  it("keeps a hidden workspace hidden for background events, and opens it for explicit navigation", () => {
    workspaceLayoutActions.setPanelMode("first", "chat");
    workspaceLayoutActions.setActiveContentTab("first", "browser");
    expect(workspaceLayoutActions.getLayout("first").panelMode).toBe("chat");

    workspaceLayoutActions.openContentTab("first", "terminal");
    const layout = workspaceLayoutActions.getLayout("first");
    expect(layout.panelMode).toBe("split");
    expect(resolveWorkspaceTabs(layout).activeTab.kind).toBe("terminal");

    workspaceLayoutActions.setPanelMode("first", "chat");
    workspaceLayoutActions.openFileInContent("first", "README.md", "files");
    expect(workspaceLayoutActions.getLayout("first").panelMode).toBe("split");
  });

  it("keeps the workspace expanded when navigating between tools and files", () => {
    workspaceLayoutActions.setPanelMode("first", "content");
    workspaceLayoutActions.openContentTab("first", "browser");
    expect(workspaceLayoutActions.getLayout("first").panelMode).toBe("content");
    workspaceLayoutActions.openFileInContent("first", "README.md", "changes");
    expect(workspaceLayoutActions.getLayout("first").panelMode).toBe("content");
  });

  it("preserves hidden/gated tabs when reordering visible tabs by (draggedId, targetId)", () => {
    const changesId = workspaceLayoutActions.openToolTab("ws-reorder", "changes");
    const browserId = workspaceLayoutActions.openBrowserTab("ws-reorder", "http://localhost:1420");
    const filesId = workspaceLayoutActions.openToolTab("ws-reorder", "files");

    // Simulate Browser hidden from visible strip: drag Files before Changes.
    workspaceLayoutActions.reorderWorkspaceTabs("ws-reorder", filesId, changesId);

    const { workspaceTabs } = workspaceLayoutActions.getLayout("ws-reorder");
    expect(workspaceTabs.map((t) => t.id)).toEqual([filesId, changesId, browserId]);
    expect(workspaceTabs.some((t) => t.id === browserId && t.kind === "browser")).toBe(true);
  });

  it("treats cloud Browser as a singleton and persists URL-less cloud preview tabs", () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);

    const cloudFirst = workspaceLayoutActions.openToolTab("ws-cloud", "browser", { cloud: true });
    const cloudSecond = workspaceLayoutActions.openBrowserTab("ws-cloud", "", { cloud: true });
    expect(cloudSecond).toBe(cloudFirst);

    // Also open a blank local browser tab to confirm only cloud URL-less tabs persist.
    workspaceLayoutActions.openBrowserTab("ws-local-blank", "");
    flushWorkspaceLayoutStorage();

    const raw = storage.getItem("workspace-layout-store");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.layouts["ws-cloud"].workspaceTabs).toHaveLength(1);
    expect(parsed.state.layouts["ws-cloud"].workspaceTabs[0]).toMatchObject({
      id: cloudFirst,
      kind: "browser",
      cloud: true,
    });
    expect(parsed.state.layouts["ws-local-blank"].workspaceTabs).toHaveLength(0);
  });

  it("restricts replaceTabId to launcher tabs so callers cannot overwrite live tabs", () => {
    const browserId = workspaceLayoutActions.openBrowserTab("ws-guard", "https://example.com");
    const termId = workspaceLayoutActions.openTerminalTab("ws-guard", {
      title: "Shell",
      replaceTabId: browserId,
    });
    const fileId = workspaceLayoutActions.openFileTab("ws-guard", "README.md", {
      replaceTabId: termId,
    });

    const { workspaceTabs } = workspaceLayoutActions.getLayout("ws-guard");
    expect(workspaceTabs.map((t) => t.id)).toEqual([browserId, termId, fileId]);
  });

  it("hydrates v11 persisted state through Zustand persist without erasing saved layouts", async () => {
    const storage = createMemoryStorage();
    const v11Payload = {
      version: 11,
      state: {
        layouts: {
          "ws-browser": {
            activeContentTab: "browser",
            selectedFilePath: "src/index.ts",
            browserTabs: [
              { id: "b-1", url: "http://localhost:3000", title: "App", isMobileView: true },
              { id: "b-blank", url: "about:blank", title: "Blank" },
              { id: "b-2", url: "https://docs.example.com", title: "Docs" },
            ],
            activeBrowserTabId: "b-2",
            panelMode: "content",
            fileTreePinned: false,
            chatTabSessionIds: ["sess-a", "sess-b"],
            activeChatTabSessionId: "sess-b",
            knownChatSessionIds: ["sess-a", "sess-b"],
            simulatorUdid: "SIM-UDID-42",
            pendingFileNavigation: { requestId: "stale", path: "old.ts", target: "files" },
          },
          "ws-changes": {
            activeContentTab: "changes",
            selectedFilePath: "README.md",
            browserTabs: [{ id: "b-3", url: "http://localhost:5173" }],
            activeBrowserTabId: "b-3",
            panelMode: "chat",
            fileTreePinned: true,
            chatTabSessionIds: ["sess-c"],
            activeChatTabSessionId: "sess-c",
            knownChatSessionIds: ["sess-c"],
            simulatorUdid: null,
          },
        },
      },
    };
    storage.setItem("workspace-layout-store", JSON.stringify(v11Payload));
    vi.stubGlobal("localStorage", storage);

    await useWorkspaceLayoutStore.persist.rehydrate();

    const browserWs = workspaceLayoutActions.getLayout("ws-browser");
    expect(browserWs.panelMode).toBe("content");
    expect(browserWs.selectedFilePath).toBe("src/index.ts");
    expect(browserWs.fileTreePinned).toBe(false);
    expect(browserWs.chatTabSessionIds).toEqual(["sess-a", "sess-b"]);
    expect(browserWs.activeChatTabSessionId).toBe("sess-b");
    expect(browserWs.knownChatSessionIds).toEqual(["sess-a", "sess-b"]);
    expect(browserWs.simulatorUdid).toBe("SIM-UDID-42");
    expect(browserWs.pendingFileNavigation).toBeNull();
    expect(browserWs.nextTerminalNum).toBe(1);
    expect(browserWs.workspaceTabs).toHaveLength(2);
    expect(browserWs.workspaceTabs[0]).toMatchObject({
      id: "b-1",
      kind: "browser",
      url: "http://localhost:3000",
      title: "App",
      isMobileView: true,
    });
    expect(browserWs.workspaceTabs[1]).toMatchObject({
      id: "b-2",
      kind: "browser",
      url: "https://docs.example.com",
      title: "Docs",
    });
    expect(browserWs.activeWorkspaceTabId).toBe("b-2");

    const changesWs = workspaceLayoutActions.getLayout("ws-changes");
    expect(changesWs.panelMode).toBe("chat");
    expect(changesWs.selectedFilePath).toBe("README.md");
    expect(changesWs.workspaceTabs.map((t) => t.kind)).toEqual(["changes", "browser"]);
    expect(resolveWorkspaceTabs(changesWs).activeTab.kind).toBe("changes");
  });

  it("preserves v11 selected cloud Browser and Terminal tools until resolved with workspace kind", async () => {
    const storage = createMemoryStorage();
    const v11Payload = {
      version: 11,
      state: {
        layouts: {
          "ws-cloud-browser": {
            activeContentTab: "browser",
            browserTabs: [],
            panelMode: "split",
          },
          "ws-term-with-urls": {
            activeContentTab: "terminal",
            browserTabs: [{ id: "b-1", url: "http://localhost:3000", title: "App" }],
            activeBrowserTabId: "b-1",
            panelMode: "content",
          },
        },
      },
    };
    storage.setItem("workspace-layout-store", JSON.stringify(v11Payload));
    vi.stubGlobal("localStorage", storage);

    await useWorkspaceLayoutStore.persist.rehydrate();

    // Before workspace opens, migratedActiveTool preserves intent without creating fake live tabs.
    const cloudPre = workspaceLayoutActions.getLayout("ws-cloud-browser");
    expect(cloudPre.migratedActiveTool).toBe("browser");
    expect(cloudPre.workspaceTabs).toHaveLength(0);

    const termPre = workspaceLayoutActions.getLayout("ws-term-with-urls");
    expect(termPre.migratedActiveTool).toBe("terminal");
    expect(termPre.workspaceTabs.map((t) => t.id)).toEqual(["b-1"]);

    // Opening the cloud workspace resolves to a singleton cloud Browser tab (not New Tab).
    workspaceLayoutActions.resolveMigratedTool("ws-cloud-browser", { cloud: true });
    const cloudPost = workspaceLayoutActions.getLayout("ws-cloud-browser");
    expect(cloudPost.migratedActiveTool).toBeNull();
    expect(resolveWorkspaceTabs(cloudPost).activeTab).toMatchObject({
      kind: "browser",
      cloud: true,
    });

    // Opening the terminal workspace opens & activates Terminal 1 while preserving saved browser URLs.
    workspaceLayoutActions.resolveMigratedTool("ws-term-with-urls", { cloud: false });
    const termPost = workspaceLayoutActions.getLayout("ws-term-with-urls");
    expect(termPost.migratedActiveTool).toBeNull();
    expect(termPost.workspaceTabs.map((t) => t.kind)).toEqual(["browser", "terminal"]);
    expect(resolveWorkspaceTabs(termPost).activeTab.kind).toBe("terminal");
    expect(termPost.panelMode).toBe("content");
  });

  it("rejects newer persisted schema versions (v13) without merging or overwriting stored bytes", async () => {
    const storage = createMemoryStorage();
    const rawV13 = JSON.stringify({
      version: 13,
      state: {
        layouts: {
          "ws-future": {
            panelMode: "content",
            workspaceTabs: [{ id: "future-1", kind: "future-tool" }],
            futureSetting: 99,
          },
        },
      },
    });
    storage.setItem("workspace-layout-store", rawV13);
    vi.stubGlobal("localStorage", storage);

    await useWorkspaceLayoutStore.persist.rehydrate();

    // Clean defaults in memory — future payload is NOT merged.
    expect(useWorkspaceLayoutStore.getState().layouts).toEqual({});
    expect(resolveWorkspaceTabs(workspaceLayoutActions.getLayout("ws-future")).activeTab.kind).toBe(
      "new-tab"
    );

    // Subsequent in-memory edits work locally but must NOT overwrite the stored v13 bytes.
    workspaceLayoutActions.openToolTab("ws-future", "changes");
    workspaceLayoutActions.setPanelMode("ws-future", "content");
    flushWorkspaceLayoutStorage();

    expect(storage.getItem("workspace-layout-store")).toBe(rawV13);

    // Once storage is replaced with a supported v12 payload, hydration resumes cleanly.
    storage.setItem(
      "workspace-layout-store",
      JSON.stringify({
        version: 12,
        state: {
          layouts: {
            "ws-ok": {
              workspaceTabs: [{ id: "c-1", kind: "changes" }],
              activeWorkspaceTabId: "c-1",
            },
          },
        },
      })
    );
    await useWorkspaceLayoutStore.persist.rehydrate();
    expect(workspaceLayoutActions.getLayout("ws-ok").workspaceTabs).toHaveLength(1);
  });

  it("validates malformed v12 payloads per-workspace without throwing", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "workspace-layout-store",
      JSON.stringify({
        version: 12,
        state: {
          layouts: {
            "ws-object-tabs": {
              workspaceTabs: { broken: true },
              activeWorkspaceTabId: 123,
              panelMode: "bogus",
            },
            "ws-partial": {
              workspaceTabs: [
                { id: "ok-changes", kind: "changes" },
                { id: "", kind: "files" },
                { id: "bad-file", kind: "file", path: "../outside.ts" },
                { id: "bad-kind", kind: "unknown" },
                null,
              ],
              activeWorkspaceTabId: "non-existent",
            },
            "ws-not-object": "corrupted",
          },
        },
      })
    );
    vi.stubGlobal("localStorage", storage);

    await useWorkspaceLayoutStore.persist.rehydrate();

    const objTabs = workspaceLayoutActions.getLayout("ws-object-tabs");
    expect(objTabs.workspaceTabs).toEqual([]);
    expect(objTabs.panelMode).toBe("split");
    expect(resolveWorkspaceTabs(objTabs).activeTab.kind).toBe("new-tab");

    const partial = workspaceLayoutActions.getLayout("ws-partial");
    expect(partial.workspaceTabs).toEqual([{ id: "ok-changes", kind: "changes" }]);
    expect(partial.activeWorkspaceTabId).toBe("ok-changes");

    const nonObj = workspaceLayoutActions.getLayout("ws-not-object");
    expect(nonObj.workspaceTabs).toEqual([]);

    // Defensive check even if a non-array is passed directly to resolveWorkspaceTabs.
    expect(
      resolveWorkspaceTabs({
        workspaceTabs: {} as unknown as [],
        activeWorkspaceTabId: null,
      }).activeTab.kind
    ).toBe("new-tab");
  });

  it("coalesces rapid browser title updates before JSON serialization", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const setItemSpy = vi.spyOn(storage, "setItem");
    const stringifySpy = vi.spyOn(JSON, "stringify");
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    try {
      const tabId = workspaceLayoutActions.openBrowserTab("ws-perf", "https://example.com");
      setItemSpy.mockClear();
      stringifySpy.mockClear();

      for (let i = 1; i <= 5; i += 1) {
        workspaceLayoutActions.updateWorkspaceTab("ws-perf", tabId, "browser", (tab) => ({
          ...tab,
          title: `Title ${i}`,
        }));
      }

      // None of the 5 updates should have serialized or written before the debounce window.
      expect(stringifySpy).not.toHaveBeenCalled();
      expect(setItemSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);

      // Exactly one serialization + write carrying the final title.
      expect(stringifySpy).toHaveBeenCalledTimes(1);
      expect(setItemSpy).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(storage.getItem("workspace-layout-store")!);
      expect(persisted.state.layouts["ws-perf"].workspaceTabs[0].title).toBe("Title 5");
    } finally {
      flushWorkspaceLayoutStorage();
      stringifySpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
