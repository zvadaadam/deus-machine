import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import { queryKeys } from "@/shared/api/queryKeys";
import { unreadActions, useUnreadStore } from "@/features/session/store/unreadStore";
import type { RepoGroup, Workspace } from "@shared/types/workspace";

const BATCH_WINDOW_MS = 1500;

const state = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  sendNotification: vi.fn(),
  showWindow: vi.fn(),
  track: vi.fn(),
  isWindowFocused: vi.fn(),
  selectWorkspace: vi.fn(),
  setChatTabState: vi.fn(),
  getLayout: vi.fn(),
  layouts: {} as Record<string, unknown>,
  selectedWorkspaceId: "A" as string | null,
  capabilities: { nativeNotifications: true },
}));

// React is mocked to bypass hook mounting. We collect effects so the test can
// invoke them at a controlled time (after the QueryClient is ready) and capture
// the unsubscribe cleanup for teardown.
const { effects } = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    effects.push(effect);
  },
  useRef: <T>(initial: T) => ({ current: initial }) as { current: T },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => state.queryClient! };
});

vi.mock("@/platform/notifications", () => ({ sendNotification: state.sendNotification }));
vi.mock("@/platform/capabilities", () => ({ capabilities: state.capabilities }));
vi.mock("@/shared/hooks/useWindowFocus", () => ({ isWindowFocused: state.isWindowFocused }));
vi.mock("@/platform/native/window", () => ({ show: state.showWindow }));
vi.mock("@/platform/analytics", () => ({ track: state.track }));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectWorkspace: state.selectWorkspace,
    }),
  },
}));

vi.mock("@/features/workspace/store/workspaceLayoutStore", () => ({
  useWorkspaceLayoutStore: {
    getState: () => ({ layouts: state.layouts }),
  },
  workspaceLayoutActions: {
    setChatTabState: state.setChatTabState,
    getLayout: state.getLayout,
  },
}));

// Mock the unread store with a real in-memory Zustand store so a single setup
// serves both call-site assertions (vi.fn wrappers around markUnread / markRead)
// and the end-to-end round-trip test (which asserts on state). The wrappers
// perform the real mutation, so `useUnreadStore.getState()` always reflects
// the net effect of every call site — exactly the production behavior.
vi.mock("@/features/session/store/unreadStore", async () => {
  const { create } = await import("zustand");
  interface UnreadState {
    unreadSessionIds: Record<string, true>;
    markUnread: (id: string) => void;
    markRead: (id: string) => void;
  }
  const useUnreadStore = create<UnreadState>((set) => ({
    unreadSessionIds: {},
    markUnread: (id) =>
      set((s) => ({
        unreadSessionIds: { ...s.unreadSessionIds, [id]: true as const },
      })),
    markRead: (id) =>
      set((s) => {
        if (!s.unreadSessionIds[id]) return s;
        const { [id]: _ignored, ...rest } = s.unreadSessionIds;
        return { unreadSessionIds: rest };
      }),
  }));
  const realMarkUnread = useUnreadStore.getState().markUnread;
  const realMarkRead = useUnreadStore.getState().markRead;
  const unreadActions = {
    markUnread: vi.fn((id: string) => realMarkUnread(id)),
    markRead: vi.fn((id: string) => realMarkRead(id)),
  };
  return { useUnreadStore, unreadActions };
});

function buildWorkspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    repository_id: "repo-1",
    slug: "ws-slug",
    title: null,
    git_branch: null,
    git_target_branch: null,
    kind: "worktree",
    provider_workspace_id: null,
    state: "ready",
    status: "idle",
    current_session_id: null,
    session_status: null,
    session_error_category: null,
    session_error_message: null,
    latest_message_sent_at: null,
    updated_at: "2026-09-07T00:00:00Z",
    repo_name: "repo",
    root_path: "/tmp",
    workspace_path: "/tmp",
    setup_status: "none",
    error_message: null,
    ...overrides,
  };
}

function buildGroup(ws: Workspace, repoName = "repo"): RepoGroup[] {
  return [{ repo_id: "repo-1", repo_name: repoName, sort_order: 0, workspaces: [ws] }];
}

function seed(groups: RepoGroup[]): void {
  state.queryClient!.setQueryData(queryKeys.workspaces.byRepo(), groups);
}

/**
 * Drive a session-status transition by emitting cache updates. The hook reads
 * `prevStatusMap` to detect transitions, so three writes are needed:
 * (1) "added" — ignored by the hook's `event.type === "updated"` filter;
 * (2) "updated" with the FROM status — records `prevStatus` in `prevStatusMap`;
 * (3) "updated" with the TO status — fires the transition logic.
 */
function transitionSession(wsFrom: Workspace, wsTo: Workspace): void {
  seed(buildGroup(wsFrom));
  seed(buildGroup(wsFrom)); // records prevStatus
  seed(buildGroup(wsTo)); // fires transition
}

let cleanup: (() => void) | undefined;

beforeEach(() => {
  // `clearAllMocks` (not `resetAllMocks`) preserves the `unreadActions`
  // implementations installed by the unreadStore mock factory — those wrap the
  // real Zustand mutations, which T1.4 / T1.8 assert against at the store level.
  vi.clearAllMocks();
  vi.useFakeTimers();
  state.queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  state.capabilities.nativeNotifications = true;
  state.isWindowFocused.mockReturnValue(false); // notifications fire when unfocused
  state.getLayout.mockReturnValue({ chatTabSessionIds: [], activeChatTabSessionId: null });
  state.layouts = {};
  state.selectedWorkspaceId = "A"; // user is on workspace A by default (off-screen for B)
  state.selectWorkspace.mockImplementation((id: string) => {
    state.selectedWorkspaceId = id;
  });
  useUnreadStore.setState({ unreadSessionIds: {} });
  effects.length = 0;
  useGlobalSessionNotifications();
  for (const e of effects) {
    const c = e();
    if (typeof c === "function") cleanup = c;
  }
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  state.queryClient!.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function clickNotification(index = 0): void {
  const calls = state.sendNotification.mock.calls;
  expect(calls.length).toBeGreaterThan(index);
  const opts = calls[index][0] as { onClick?: () => void };
  expect(typeof opts.onClick).toBe("function");
  opts.onClick!();
}

/**
 * Advance fake timers past the finished-notification batching window so any
 * queued `queueFinished` entry is flushed into a `sendNotification` call.
 * Tests that exercise the batched "Agent finished" path must call this before
 * asserting on `sendNotification` or clicking the notification.
 */
function flushFinished(): void {
  vi.advanceTimersByTime(BATCH_WINDOW_MS);
}

// ───────────────────────────────────────────────────────────────────────────
// Clicking a session-level notification clears that session's unread entry.
// Regression guard for navigateToWorkspace's markRead side effect, with
// coverage of every notification type and every navigateToWorkspace branch.
// ───────────────────────────────────────────────────────────────────────────
describe("navigateToWorkspace clears the clicked session's unread state", () => {
  it("marks the clicked-finished session as read in the real unread store", () => {
    transitionSession(
      buildWorkspace({ id: "B", current_session_id: "S2", session_status: "working" }),
      buildWorkspace({ id: "B", current_session_id: "S2", session_status: "idle" })
    );
    flushFinished();

    expect(unreadActions.markUnread).toHaveBeenCalledExactlyOnceWith("S2");
    expect(state.sendNotification).toHaveBeenCalledOnce();
    expect(state.sendNotification.mock.calls[0][0]).toHaveProperty("title", "Agent finished");
    // The hook genuinely wrote through `unreadActions.markUnread`.
    expect(useUnreadStore.getState().unreadSessionIds).toEqual({ S2: true });

    clickNotification();

    expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
    expect(state.showWindow).toHaveBeenCalledOnce();
    expect(state.selectWorkspace).toHaveBeenCalledExactlyOnceWith("B");
    // The fix's markRead call genuinely cleared the entry — same surface production uses.
    expect(useUnreadStore.getState().unreadSessionIds).toEqual({});
  });

  // Every session-level notification type routes its onClick through
  // navigateToWorkspace, so every type must clear unread. A future
  // notification type added without markRead would slip past this guard.
  describe("every session-level notification type clears unread", () => {
    function ws(id: string, sessionId: string, status: Workspace["session_status"]) {
      return buildWorkspace({ id, current_session_id: sessionId, session_status: status });
    }

    it("(a) single-finished → idle", () => {
      transitionSession(ws("B", "S2", "working"), ws("B", "S2", "idle"));
      flushFinished();
      clickNotification();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
      expect(state.showWindow).toHaveBeenCalledOnce();
      expect(state.selectWorkspace).toHaveBeenCalledExactlyOnceWith("B");
    });

    it("(b) batched-finished (only batch[0] is navigated)", () => {
      const wb = ws("B", "S2", "working");
      const wc = ws("C", "S3", "working");
      // Prime + transition both. The batching is triggered by the idle writes.
      seed(buildGroup(wb));
      seed(buildGroup(wc));
      seed(buildGroup({ ...wb, session_status: "idle" }));
      seed(buildGroup({ ...wc, session_status: "idle" }));
      // Both go through the SAME batch; advance to flush.
      vi.advanceTimersByTime(BATCH_WINDOW_MS);

      // Batching produces exactly one notification.
      expect(state.sendNotification).toHaveBeenCalledOnce();
      expect(state.sendNotification.mock.calls[0][0]).toHaveProperty("title", "2 agents finished");
      expect(unreadActions.markUnread).toHaveBeenCalledWith("S2");
      expect(unreadActions.markUnread).toHaveBeenCalledWith("S3");

      clickNotification();

      // Per the documented contract, only batch[0]'s session is cleared.
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
    });

    it("(c) needs_response", () => {
      transitionSession(ws("B", "S2", "working"), ws("B", "S2", "needs_response"));
      expect(state.sendNotification.mock.calls[0][0]).toHaveProperty("title", "Agent needs input");
      clickNotification();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
    });

    it("(d) needs_plan_response", () => {
      transitionSession(ws("B", "S2", "working"), ws("B", "S2", "needs_plan_response"));
      expect(state.sendNotification.mock.calls[0][0]).toHaveProperty(
        "title",
        "Plan ready for review"
      );
      clickNotification();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
    });

    it("(e) error", () => {
      transitionSession(
        ws("B", "S2", "working"),
        buildWorkspace({
          id: "B",
          current_session_id: "S2",
          session_status: "error",
          session_error_category: "auth",
        })
      );
      expect(state.sendNotification.mock.calls[0][0]).toHaveProperty(
        "title",
        "Authentication Error"
      );
      clickNotification();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
    });
  });

  // markRead is placed before the layout-branch logic so it fires on every
  // branch. A refactor that moves it into a single branch — or drops it from
  // an early-return path — would leak the unread entry this fix is meant to clear.
  describe("every navigateToWorkspace branch clears unread", () => {
    function primeNClick(): void {
      transitionSession(
        buildWorkspace({ id: "B", current_session_id: "S2", session_status: "working" }),
        buildWorkspace({ id: "B", current_session_id: "S2", session_status: "idle" })
      );
      flushFinished();
      unreadActions.markRead.mockClear();
      state.setChatTabState.mockClear();
      clickNotification();
    }

    it("(a) no persisted layout — early-returns without setChatTabState but still clears unread", () => {
      state.layouts = {};
      primeNClick();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
      expect(state.setChatTabState).not.toHaveBeenCalled();
    });

    it("(b) already-active session — early-returns but still clears unread", () => {
      state.layouts = {
        B: { chatTabSessionIds: ["S2"], activeChatTabSessionId: "S2" },
      };
      primeNClick();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S2");
      expect(state.setChatTabState).not.toHaveBeenCalled();
    });

    it("(c) append + activate — setChatTabState fires and clears unread", () => {
      state.layouts = {
        B: { chatTabSessionIds: ["S_old"], activeChatTabSessionId: "S_old" },
      };
      unreadActions.markRead.mockClear();
      state.setChatTabState.mockClear();
      transitionSession(
        buildWorkspace({ id: "B", current_session_id: "S_new", session_status: "working" }),
        buildWorkspace({ id: "B", current_session_id: "S_new", session_status: "idle" })
      );
      flushFinished();
      clickNotification();
      expect(unreadActions.markRead).toHaveBeenCalledExactlyOnceWith("S_new");
      expect(state.setChatTabState).toHaveBeenCalledExactlyOnceWith(
        "B",
        ["S_old", "S_new"],
        "S_new"
      );
    });
  });
});
