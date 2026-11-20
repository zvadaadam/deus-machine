// How a workspace's chat tabs follow its live chat list (app/layouts/chatTabsSync).
import { describe, expect, it } from "vitest";
import { arrivedWhileAway, reconcileLive, sessionToTab } from "@/app/layouts/chatTabsSync";
import type { Session } from "@/features/session/types";

const chat = (id: string, message_count = 1): Session =>
  ({ id, workspace_id: "w", agent_harness: "claude-code", message_count, status: "idle" }) as never;
const closedTab = (sessionId: string) =>
  ({
    id: `c-${sessionId}`,
    sessionId,
    label: "x",
    agentHarness: "claude-code",
    hasStarted: true,
    closedAt: 1,
  }) as never;

describe("tabs that follow the live chat list (H9, H21)", () => {
  it("two live updates with nothing changed give back the same arrays: no render loop", () => {
    const a = chat("a");
    const state = { tabs: [sessionToTab(a, 1)], closed: [closedTab("b")] };
    const sessions = [a, chat("b")];
    const seen = new Set(["a", "b"]);
    const first = reconcileLive(state, sessions, seen);
    expect(first.tabs).toBe(state.tabs);
    expect(first.closed).toBe(state.closed);
    const second = reconcileLive(first, [...sessions], seen);
    expect(second.tabs).toBe(state.tabs);
    expect(second.closed).toBe(state.closed);
  });

  it("a chat that arrives becomes a tab; one the person closed does not come back; one put away leaves", () => {
    const state = {
      tabs: [sessionToTab(chat("a"), 1), sessionToTab(chat("gone"), 2)],
      closed: [closedTab("b")],
    };
    const next = reconcileLive(
      state,
      [chat("a"), chat("b"), chat("new")],
      new Set(["a", "b", "gone"])
    );
    expect(next.tabs.map((t) => (t as { sessionId: string }).sessionId)).toEqual(["a", "new"]);
    expect(next.closed).toBe(state.closed);
    const after = reconcileLive(next, [chat("a"), chat("new")], new Set(["a", "b", "new"]));
    expect(after.closed).toEqual([]);
  });

  it("on mount, chats that arrived while away open; with no saved knowledge none do", () => {
    const sessions = [chat("a"), chat("closed-earlier"), chat("while-away")];
    expect(
      arrivedWhileAway(sessions, new Set(["a"]), ["a", "closed-earlier"]).map((s) => s.id)
    ).toEqual(["while-away"]);
    expect(arrivedWhileAway(sessions, new Set(["a"]), [])).toEqual([]);
  });
});

describe("an open-chat request (H22)", () => {
  it("is taken by its identity, once: a newer request for the workspace stays", async () => {
    const { openChat, openChatDone, useOpenChatStore } =
      await import("@/features/session/lib/openChat");
    openChat("w", "first");
    const first = useOpenChatStore.getState().requested.w!;
    openChat("w", "second");
    openChatDone("w", first.id);
    expect(useOpenChatStore.getState().requested.w?.sessionId).toBe("second");
    openChatDone("w", useOpenChatStore.getState().requested.w!.id);
    expect(useOpenChatStore.getState().requested.w).toBeUndefined();
  });
});
