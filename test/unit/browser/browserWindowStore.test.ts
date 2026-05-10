import { beforeEach, describe, expect, it } from "vitest";
import {
  useBrowserWindowStore,
  browserWindowActions,
} from "@/features/browser/store/browserWindowStore";

function resetBrowserWindowStore(): void {
  useBrowserWindowStore.setState({
    pendingNewTab: null,
    pendingNewTabQueue: [],
    pendingCloseTab: null,
    pendingCloseTabQueue: [],
    pendingCloseTabById: null,
    pendingCloseTabByIdQueue: [],
    focusModeByWorkspace: {},
  });
}

describe("browserWindowStore", () => {
  beforeEach(() => {
    resetBrowserWindowStore();
  });

  it("queues remote tab open requests so rapid relay events are not dropped", () => {
    browserWindowActions.requestNewTab("ws-1", "https://one.example/", "tab-1");
    browserWindowActions.requestNewTab("ws-1", "https://two.example/", "tab-2");

    expect(useBrowserWindowStore.getState().pendingNewTab).toMatchObject({
      workspaceId: "ws-1",
      url: "https://one.example/",
      tabId: "tab-1",
    });

    browserWindowActions.consumePendingNewTab();

    expect(useBrowserWindowStore.getState().pendingNewTab).toMatchObject({
      workspaceId: "ws-1",
      url: "https://two.example/",
      tabId: "tab-2",
    });

    browserWindowActions.consumePendingNewTab();

    expect(useBrowserWindowStore.getState().pendingNewTab).toBeNull();
    expect(useBrowserWindowStore.getState().pendingNewTabQueue).toEqual([]);
  });

  it("queues close requests independently by URL prefix and explicit tab id", () => {
    browserWindowActions.requestCloseTabByUrlPrefix("ws-1", "http://localhost:3000/");
    browserWindowActions.requestCloseTabByUrlPrefix("ws-1", "http://localhost:3001/");
    browserWindowActions.requestCloseTabById("tab-1", "ws-1");
    browserWindowActions.requestCloseTabById("tab-2", "ws-1");

    expect(useBrowserWindowStore.getState().pendingCloseTab).toMatchObject({
      workspaceId: "ws-1",
      urlPrefix: "http://localhost:3000/",
    });
    expect(useBrowserWindowStore.getState().pendingCloseTabById).toMatchObject({
      workspaceId: "ws-1",
      tabId: "tab-1",
    });

    browserWindowActions.consumePendingCloseTab();
    browserWindowActions.consumePendingCloseTabById();

    expect(useBrowserWindowStore.getState().pendingCloseTab).toMatchObject({
      workspaceId: "ws-1",
      urlPrefix: "http://localhost:3001/",
    });
    expect(useBrowserWindowStore.getState().pendingCloseTabById).toMatchObject({
      workspaceId: "ws-1",
      tabId: "tab-2",
    });
  });
});
