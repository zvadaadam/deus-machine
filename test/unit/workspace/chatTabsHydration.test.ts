import { act, createElement, startTransition } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create } from "zustand";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uuidv7 } from "@shared/lib/uuid";
import * as tabSync from "@/app/layouts/chatTabsSync";
import { useChatTabs } from "@/app/layouts/useChatTabs";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import {
  currentOpenChatRequest,
  openChat,
  useOpenChatStore,
} from "@/features/session/lib/openChat";
import type { Session } from "@/features/session/types";
import { useSidebarStore } from "@/features/sidebar/store";
import { copyWorkspaceLink } from "@/features/workspace/lib/workspaceAddress";
import {
  useWorkspaceLayoutStore,
  useWorkspaceStore,
  workspaceLayoutActions,
} from "@/features/workspace/store";
import { sendNotification } from "@/platform/notifications";
import { uiActions, useUIStore } from "@/shared/stores/uiStore";

const useList = create<{ data: Session[] | undefined; dataUpdatedAt: number }>(() => ({
  data: undefined,
  dataUpdatedAt: 0,
}));
vi.hoisted(() => {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
});
vi.mock("@/features/session/api/session.queries", () => ({
  useWorkspaceSessions: () => useList(),
  useCreateSession: () => ({}),
  useWorkingSessionIds: () => {},
}));
vi.mock("@/platform/notifications", () => ({ sendNotification: vi.fn() }));
vi.mock("@/platform/capabilities", () => ({ capabilities: { nativeNotifications: true } }));
vi.mock("@/shared/hooks/useWindowFocus", () => ({ isWindowFocused: () => false }));

const chat = (id: string): Session => ({
  id,
  workspace_id: "w",
  agent_harness: "claude-code",
  status: "idle",
  message_count: 1,
  context_token_count: 0,
  context_used_percent: 0,
  is_hidden: false,
  updated_at: "2026-01-01 00:00:00",
});
let root: Root;
let view: ReturnType<typeof useChatTabs>;

function Tabs() {
  view = useChatTabs({ workspaceId: "w", activeSessionId: "a" });
  return null;
}

beforeEach(() => {
  // This component renders no elements. React needs only a root and window to receive events.
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  useWorkspaceLayoutStore.setState({ layouts: {} });
  useList.setState({ data: undefined, dataUpdatedAt: 0 });
  useOpenChatStore.setState({ requested: {} });
});
afterEach(() => {
  act(() => root.unmount());
  uiActions.closeAllModals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function readList(ids: string[]) {
  act(() => useList.setState({ data: ids.map(chat), dataUpdatedAt: Date.now() }));
}

it.each([
  ["no saved tabs", []],
  ["the first tab saved", ["a"]],
])("opens the requested chat after hydration with %s", (_name, saved) => {
  workspaceLayoutActions.setLayout("w", {
    chatTabSessionIds: saved,
    activeChatTabSessionId: saved[0] ?? null,
  });
  openChat("w", "b");
  const published: (string | null)[] = [];
  const unsubscribeLayout = useWorkspaceLayoutStore.subscribe(({ layouts }) => {
    published.push(layouts.w.activeChatTabSessionId);
  });
  const activeAtAcknowledgment: string[] = [];
  const unsubscribe = useOpenChatStore.subscribe((state, prev) => {
    if (prev.requested.w && !state.requested.w) activeAtAcknowledgment.push(view.activeTabId);
  });
  act(() => root.render(createElement(Tabs)));
  readList(["a", "b"]);
  unsubscribeLayout();
  unsubscribe();
  expect(view.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
  expect(view.activeTabId).toBe("tab-b");
  expect(activeAtAcknowledgment).toEqual(["tab-b"]);
  expect(published[0]).toBe("b");
  expect(published).not.toContain("a");

  const hydrated = view.tabs;
  readList(["a", "b"]);
  expect(view.tabs).toBe(hydrated);
  readList(["a", "b", "c"]);
  expect(view.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b", "tab-c"]);
  expect(view.activeTabId).toBe("tab-b");
});

it("falls back to the remaining tab when the saved active chat was deleted", () => {
  const reconcile = vi.spyOn(tabSync, "reconcileLive");
  workspaceLayoutActions.setLayout("w", {
    chatTabSessionIds: ["a", "deleted"],
    activeChatTabSessionId: "deleted",
  });
  act(() => root.render(createElement(Tabs)));
  readList(["a", "b"]);
  expect(view.tabs.map((tab) => tab.id)).toEqual(["tab-a"]);
  expect(view.activeTabId).toBe("tab-a");

  // Committing hydration runs reconciliation once more, before any later list read.
  expect(reconcile).toHaveBeenCalled();
  for (const [index, [before]] of reconcile.mock.calls.entries()) {
    const after = reconcile.mock.results[index].value;
    expect(after.tabs).toBe(before.tabs);
    expect(after.closed).toBe(before.closed);
  }
});

it("publishes the restored chat once when React replays its tab update", () => {
  workspaceLayoutActions.setChatTabState("w", ["a", "b"], "a");
  act(() => root.render(createElement(Tabs)));
  readList(["a", "b"]);
  act(() => view.handleTabClose("tab-a"));
  const [closed] = view.closedTabs;
  const published: (string | null)[] = [];
  const stop = useWorkspaceLayoutStore.subscribe(({ layouts }) =>
    published.push(layouts.w.activeChatTabSessionId)
  );

  act(() => {
    // The pending list update makes React apply the restore again after the click commits.
    startTransition(() => view.handleTabReorder([...view.tabs]));
    flushSync(() => view.handleTabRestore(closed));
  });
  stop();

  expect(published).toEqual(["a"]);
  expect(useWorkspaceLayoutStore.getState().layouts.w.chatTabSessionIds).toEqual(["b", "a"]);
  act(() => view.handleTabReorder([...view.tabs].reverse()));
  expect(useWorkspaceLayoutStore.getState().layouts.w.chatTabSessionIds).toEqual(["a", "b"]);
});

it("leaves the saved tab active when the request expired before the workspace opened", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  openChat("w", "b");
  expect(currentOpenChatRequest("w")?.sessionId).toBe("b");
  now.mockReturnValue(11_001);
  expect(currentOpenChatRequest("w")).toBeUndefined();
  act(() => root.render(createElement(Tabs)));
  readList(["a", "b"]);
  expect(view.activeTabId).toBe("tab-a");
  expect(useOpenChatStore.getState().requested.w).toBeUndefined();
});

it("copies the saved chat when a pending request expires while the palette is open", async () => {
  vi.useFakeTimers();
  const home = "https://deusmachine.ai/s/local";
  Object.assign(window, { location: new URL(home) });
  const workspaceId = uuidv7();
  const saved = uuidv7();
  const requested = uuidv7();
  workspaceLayoutActions.setChatTabState(workspaceId, [saved], saved);
  openChat(workspaceId, requested);
  uiActions.openAutomations();
  uiActions.openCommandPalette();
  const copy = vi.fn().mockResolvedValue(true);
  const clickCopyChat = () => copyWorkspaceLink(workspaceId, "chat", copy);
  const pending = useOpenChatStore.getState();
  expect(currentOpenChatRequest(workspaceId)?.sessionId).toBe(requested);
  vi.advanceTimersByTime(10_001);
  await clickCopyChat();

  expect(useOpenChatStore.getState()).toBe(pending);
  expect(copy.mock.calls).toEqual([[`${home}/w/${workspaceId}?session=${saved}`]]);
});

it.each(["openAutomations", "openCustomize", "openSettings", "openCommandPalette"] as const)(
  "reveals a linked chat after %s",
  (openView) => {
    uiActions[openView]();
    workspaceLayoutActions.setPanelMode("w", "content");
    const showPanel = vi.spyOn(workspaceLayoutActions, "setPanelMode").mockImplementation(() => {});
    openChat("w", "b");
    expect(useUIStore.getState()).toMatchObject({
      automationsOpen: false,
      customizeOpen: false,
      settingsOpen: false,
      commandPaletteOpen: false,
    });
    expect(showPanel).toHaveBeenCalledWith("w", "split");
  }
);

it("reveals a workspace under Automations when its failed-start notification is clicked", () => {
  function Notifications() {
    useGlobalSessionNotifications();
    return null;
  }
  const client = new QueryClient();
  const expand = vi.spyOn(useSidebarStore.getState(), "expandRepo").mockImplementation(() => {});
  act(() =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Notifications)))
  );
  uiActions.openAutomations();
  const workspace = { id: "failed", repository_id: "repo", slug: "work" };
  for (const state of ["initializing", "error"]) {
    client.setQueryData(
      ["workspaces", "by-repo"],
      [{ repo_name: "Project", workspaces: [{ ...workspace, state }] }]
    );
  }
  const notification = vi.mocked(sendNotification).mock.lastCall?.[0];
  expect(notification?.title).toBe("Workspace didn't start");
  notification?.onClick?.();
  expect(useWorkspaceStore.getState().selectedWorkspaceId).toBe("failed");
  expect(useUIStore.getState().automationsOpen).toBe(false);
  expect(expand).toHaveBeenCalledWith("repo");
});
