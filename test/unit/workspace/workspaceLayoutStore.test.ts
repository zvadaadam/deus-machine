import { beforeEach, describe, expect, it } from "vitest";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";

describe("workspaceLayoutStore", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });

    useWorkspaceLayoutStore.setState({ layouts: {} });
  });

  it("opens a file in the requested content tab and queues a reveal request", () => {
    workspaceLayoutActions.openFileInContent("ws-123", "./src/demo.tsx", "files");

    const layout = useWorkspaceLayoutStore.getState().getLayout("ws-123");

    expect(layout.activeContentTab).toBe("files");
    expect(layout.selectedFilePath).toBe("src/demo.tsx");
    expect(layout.contentPanelCollapsed).toBe(false);
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
});
