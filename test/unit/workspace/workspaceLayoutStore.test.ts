import { beforeEach, describe, expect, it } from "vitest";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";

describe("workspaceLayoutStore", () => {
  beforeEach(() => {
    workspaceLayoutActions.resetAll();
  });

  it("opens a file in the requested content tab and queues a reveal request", () => {
    workspaceLayoutActions.openFileInContent("ws-123", "./src/demo.tsx", "files");

    const layout = useWorkspaceLayoutStore.getState().getLayout("ws-123");

    expect(layout.activeContentTab).toBe("files");
    expect(layout.selectedFilePath).toBe("src/demo.tsx");
    expect(layout.panelMode).toBe("split");
    expect(layout.pendingFileNavigation).toMatchObject({
      path: "src/demo.tsx",
      target: "files",
    });
    expect(layout.pendingFileNavigation?.requestId).toEqual(expect.any(String));
  });

  it("issues a fresh reveal request even when reopening the same file", () => {
    workspaceLayoutActions.openFileInContent("ws-123", "src/demo.tsx", "changes");
    const firstRequestId = useWorkspaceLayoutStore.getState().getLayout("ws-123")
      .pendingFileNavigation?.requestId;

    workspaceLayoutActions.openFileInContent("ws-123", "src/demo.tsx", "changes");
    const secondLayout = useWorkspaceLayoutStore.getState().getLayout("ws-123");

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

  it("changes views without losing tool or session state or touching another workspace", () => {
    workspaceLayoutActions.setLayout("first", {
      activeContentTab: "browser",
      browserTabs: [{ id: "preview", url: "http://localhost:3000", title: "Preview" }],
      activeBrowserTabId: "preview",
      selectedFilePath: "README.md",
    });
    workspaceLayoutActions.setChatTabState("first", ["claude", "codex"], "codex");
    workspaceLayoutActions.setTerminalTabState(
      "first",
      [{ id: "shell", title: "Dev server" }],
      "shell",
      2
    );
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
    expect(workspaceLayoutActions.getLayout("first")).toMatchObject({
      panelMode: "split",
      activeContentTab: "terminal",
    });

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
});
