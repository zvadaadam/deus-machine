import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveWorkspaceTabs,
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";
import { DEFAULT_NEW_TAB_ID } from "@/features/workspace-tabs/types";
import { getTerminalInitialCommand } from "@/features/terminal/store/terminalTaskStore";

const storage = vi.hoisted(() => {
  const storage = {
    getItem: vi.fn<() => string | null>(() => null),
    setItem: vi.fn<(key: string, value: string) => void>(),
  };
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
});

describe("workspaceLayoutStore", () => {
  beforeEach(() => {
    workspaceLayoutActions.resetAll();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("defaults a fresh workspace to a single New Tab", () => {
    const layout = workspaceLayoutActions.getLayout("ws-fresh");
    const resolved = resolveWorkspaceTabs(layout);

    expect(resolved.tabs).toHaveLength(1);
    expect(resolved.activeTabId).toBe(DEFAULT_NEW_TAB_ID);
    expect(resolved.activeTab).toEqual({ id: DEFAULT_NEW_TAB_ID, kind: "new-tab" });
  });

  it("resets v12 layouts before the next workspace write", async () => {
    workspaceLayoutActions.openFileTab("open", "before.md");
    storage.setItem.mockClear();
    storage.getItem.mockReturnValueOnce(
      JSON.stringify({
        version: 12,
        state: {
          layouts: {
            a: {
              workspaceTabs: [{ id: "changes", kind: "changes" }, null],
              activeWorkspaceTabId: "gone",
            },
            b: { workspaceTabs: { broken: true } },
          },
        },
      })
    );
    await useWorkspaceLayoutStore.persist.rehydrate();
    expect(storage.setItem.mock.calls.map(([name, value]) => [name, JSON.parse(value)])).toEqual([
      ["workspace-layout-store", { state: { layouts: {} }, version: 13 }],
    ]);
    expect(useWorkspaceLayoutStore.getState().layouts).toEqual({});
    workspaceLayoutActions.openFileTab("a", "README.md");
    const saved = JSON.parse(storage.setItem.mock.lastCall![1]);
    expect(saved.version).toBe(13);
    expect(saved.state.layouts.a.workspaceTabs).toEqual([
      { id: expect.any(String), kind: "file", path: "README.md" },
    ]);
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
    const cloudFirst = workspaceLayoutActions.openToolTab("ws-cloud", "browser", { cloud: true });
    const cloudSecond = workspaceLayoutActions.openBrowserTab("ws-cloud", "", { cloud: true });
    expect(cloudSecond).toBe(cloudFirst);

    // Also open a blank local browser tab to confirm only cloud URL-less tabs persist.
    workspaceLayoutActions.openBrowserTab("ws-local-blank", "");

    const [key, raw] = storage.setItem.mock.lastCall!;
    expect(key).toBe("workspace-layout-store");
    const parsed = JSON.parse(raw);
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

  it("selects the visible successor when closing an active tab adjacent to a hidden tab", () => {
    const changesId = workspaceLayoutActions.openToolTab("ws-hidden-close", "changes");
    const filesId = workspaceLayoutActions.openToolTab("ws-hidden-close", "files");
    const browserId = workspaceLayoutActions.openBrowserTab(
      "ws-hidden-close",
      "http://localhost:1420"
    );
    const agentId = workspaceLayoutActions.openToolTab("ws-hidden-close", "config");

    workspaceLayoutActions.selectWorkspaceTab("ws-hidden-close", filesId);
    // Simulate Browser hidden from visible strip [Changes, Files, Agent]: closing Files selects Agent.
    workspaceLayoutActions.closeWorkspaceTab("ws-hidden-close", filesId, {
      nextActiveTabId: agentId,
    });

    const layout = workspaceLayoutActions.getLayout("ws-hidden-close");
    expect(layout.workspaceTabs.map((t) => t.id)).toEqual([changesId, browserId, agentId]);
    expect(layout.activeWorkspaceTabId).toBe(agentId);
  });
});
