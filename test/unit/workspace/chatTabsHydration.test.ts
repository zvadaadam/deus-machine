import { act, createElement, startTransition } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { queryKeys } from "@/shared/api/queryKeys";
import { Socket } from "../../../packages/runtime-client/test/socket";
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
import { useUnreadStore } from "@/features/session/store/unreadStore";
import type { Session } from "@/features/session/types";
import { useSidebarStore } from "@/features/sidebar/store";
import { copyWorkspaceLink, currentChatLink } from "@/features/workspace/lib/workspaceAddress";
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
let tabCache: QueryClient;
let view: ReturnType<typeof useChatTabs>;

function Tabs() {
  return createElement(QueryClientProvider, { client: tabCache }, createElement(TabView));
}

function TabView() {
  view = useChatTabs({ workspaceId: "w", activeSessionId: "a" });
  return null;
}

beforeEach(() => {
  tabCache = new QueryClient();
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

it("keeps a background tab's session detail current until the tab closes", async () => {
  const socket = new Socket();
  const runtime = new RuntimeClient(
    { host: "mac", account: "a", grant: "local" },
    { open: () => socket, queryClient: tabCache, heartbeatIntervalMs: 0 }
  );
  try {
    const connected = runtime.connect();
    await Promise.resolve();
    socket.open();
    socket.message({ type: "connected" });
    await connected;
    workspaceLayoutActions.setChatTabState("w", ["a", "b"], "a", ["a", "b"]);
    act(() => root.render(createElement(Tabs)));
    readList(["a", "b"]);
    const sub = socket
      .frames("q:subscribe")
      .find(
        (f) => f.resource === "session" && (f.params as { sessionId: string }).sessionId === "b"
      );
    expect(sub).toBeDefined();
    const key = queryKeys.sessions.detail("b");
    tabCache.setQueryData(key, { ...chat("b"), status: "working" });
    socket.message({ type: "q:snapshot", id: sub!.id, data: chat("b") });
    expect(tabCache.getQueryData<Session>(key)?.status).toBe("idle");
    act(() => view.handleTabChange("tab-b"));
    expect(socket.frames("q:unsubscribe")).toEqual([]);
    act(() => view.handleTabClose("tab-b"));
    expect(socket.frames("q:unsubscribe")).toContainEqual(expect.objectContaining({ id: sub!.id }));
  } finally {
    runtime.dispose();
  }
});

it.each([
  ["no saved tabs", []],
  ["the first tab saved", ["a"]],
])("opens the requested chat after hydration with %s", (_name, saved) => {
  workspaceLayoutActions.setLayout("w", {
    chatTabSessionIds: saved,
    activeChatTabSessionId: saved[0] ?? null,
  });
  openChat("w", "b");
  useUnreadStore.setState({ unreadSessionIds: { a: true, b: true } });
  const published: (string | null)[] = [];
  const unsubscribeLayout = useWorkspaceLayoutStore.subscribe(({ layouts }) => {
    published.push(layouts.w.activeChatTabSessionId);
  });
  const activeAtAcknowledgment: string[] = [];
  const unsubscribe = useOpenChatStore.subscribe((state, prev) => {
    if (prev.requested.w && !state.requested.w) activeAtAcknowledgment.push(view.activeTabId);
  });
  act(() => root.render(createElement(Tabs)));
  expect(useUnreadStore.getState().unreadSessionIds).toEqual({ a: true, b: true });
  readList(["a", "b"]);
  unsubscribeLayout();
  unsubscribe();
  expect(view.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
  expect(view.activeTabId).toBe("tab-b");
  expect(useUnreadStore.getState().unreadSessionIds).toEqual({ a: true });
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
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  const clickCopyChat = () => copyWorkspaceLink(currentChatLink(workspaceId));
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
  const workspace = { id: "failed", chats: [], repository_id: "repo", slug: "work" };
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

it("names the usage limit in a background chat's notification", () => {
  function Notifications() {
    useGlobalSessionNotifications();
    return null;
  }
  const client = new QueryClient();
  vi.mocked(sendNotification).mockClear();
  act(() =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Notifications)))
  );
  for (const status of ["working", "error"]) {
    client.setQueryData(
      ["workspaces", "by-repo"],
      [
        {
          repo_name: "Project",
          workspaces: [
            {
              id: "w",
              slug: "work",
              chats: [
                { id: "b", status, error_category: status === "error" ? "usage_limit" : null },
              ],
            },
          ],
        },
      ]
    );
  }
  expect(sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Usage limit reached", body: "Project · work" })
  );
});

it.each(["w", "elsewhere"])(
  "marks only unseen finished chats unread with %s selected and counts their workspace once",
  (selectedWorkspaceId) => {
    vi.useFakeTimers();
    vi.mocked(sendNotification).mockClear();
    const client = new QueryClient();
    useUnreadStore.setState({ unreadSessionIds: {} });
    useWorkspaceStore.setState({ selectedWorkspaceId });
    function Notifications() {
      useGlobalSessionNotifications();
      return null;
    }
    act(() =>
      root.render(createElement(QueryClientProvider, { client }, createElement(Notifications)))
    );
    for (const status of ["working", "idle"]) {
      client.setQueryData(
        ["workspaces", "by-repo"],
        [
          {
            repo_name: "Project",
            workspaces: [
              {
                id: "w",
                slug: "work",
                current_session_id: "a",
                session_status: status,
                chats: [
                  { id: "a", status },
                  { id: "b", status },
                  { id: "c", status },
                ],
              },
            ],
          },
        ]
      );
    }
    expect(useUnreadStore.getState().unreadSessionIds).toEqual(
      selectedWorkspaceId === "w" ? { b: true, c: true } : { a: true, b: true, c: true }
    );
    vi.advanceTimersByTime(1500);
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "3 agents finished",
        body: "Project · 1 workspace",
        sound: "Glass",
      })
    );
  }
);

it("can reopen a visible chat whose tab was closed before the workspace remounted", () => {
  workspaceLayoutActions.setChatTabState("w", ["a"], "a", ["a", "b", "c"]);
  act(() => root.render(createElement(Tabs)));
  readList(["a", "b", "c"]);
  const closed = view.closedTabs.find((tab) => tab.sessionId === "b");
  expect(closed).toBeDefined();
  act(() => view.handleTabRestore(closed!));
  expect(view.activeTabId).toBe("tab-b");
  act(() => view.handleTabClose("tab-b"));
  expect(view.closedTabs.map((tab) => tab.sessionId)).toEqual(["b", "c"]);
  readList(["a", "c"]);
  expect(view.closedTabs.map((tab) => tab.sessionId)).toEqual(["c"]);
});

it("reopens all 23 closed chats in reverse close order", () => {
  const ids = ["a", ...Array.from({ length: 23 }, (_, n) => `s${n}`)];
  workspaceLayoutActions.setChatTabState("w", ids, "a", ids);
  act(() => root.render(createElement(Tabs)));
  readList(ids);
  for (const id of ids.slice(1)) act(() => view.handleTabClose(`tab-${id}`));
  expect(view.closedTabs.map((tab) => tab.sessionId)).toContain("s0");
  expect(view.closedTabs).toHaveLength(23);
  for (const id of ids.slice(1).reverse()) {
    act(() => view.handleTabRestore(view.closedTabs[0]));
    expect(view.activeTabId).toBe(`tab-${id}`);
  }
});

it("reopens a chat with the label it had when closed in this visit", () => {
  workspaceLayoutActions.setChatTabState("w", ["b", "a"], "b");
  act(() => root.render(createElement(Tabs)));
  readList(["a", "b"]);
  const label = view.tabs[1].label;
  const focusKey = view.focusActiveTabKey;
  expect(label).toMatch(/#2$/);
  act(() => view.handleTabClose("tab-a"));
  expect(view.activeTabId).toBe("tab-b");
  expect(view.focusActiveTabKey).toBe(focusKey + 1);
  expect(view.closedTabs[0].label).toBe(label);
  act(() => view.handleTabRestore(view.closedTabs[0]));
  expect(view.activeTab?.label).toBe(label);
});

it("reopens a chat that started elsewhere with its live agent and label", () => {
  workspaceLayoutActions.setChatTabState("w", ["a", "b"], "b");
  act(() => root.render(createElement(Tabs)));
  act(() => useList.setState({ data: [chat("a"), { ...chat("b"), message_count: 0 }] }));
  act(() => view.handleTabClose("tab-b"));
  expect(view.closedTabs[0]).toMatchObject({ hasStarted: false, label: "New chat" });

  act(() =>
    useList.setState({ data: [chat("a"), { ...chat("b"), agent_harness: "codex-app-server" }] })
  );
  const started = { agentHarness: "codex-app-server", hasStarted: true, label: "Codex #1" };
  expect(view.closedTabs[0]).toMatchObject(started);
  act(() => view.handleTabRestore(view.closedTabs[0]));
  expect(view.activeTab).toMatchObject(started);
});
