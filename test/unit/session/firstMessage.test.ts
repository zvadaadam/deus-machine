import { describe, expect, it } from "vitest";
import { dueFirstMessages, missedFirstMessages } from "@/features/session/lib/firstMessage";

const first = { message: "fix the login page", model: "opus" };
const starting = {
  id: "a",
  state: "initializing",
  kind: "worktree",
  current_session_id: null,
  latest_message_sent_at: null,
  session_status: null,
} as const;
const ready = { ...starting, state: "ready", current_session_id: "chat-a" } as const;

describe("the message typed before its workspace existed", () => {
  it("waits while the workspace starts, and while a failed one has no chat", () => {
    expect(dueFirstMessages([starting], { a: first })).toEqual([]);
    expect(dueFirstMessages([{ ...starting, state: "error" }], { a: first })).toEqual([]);
  });

  it("goes to the workspace's first chat once it is ready", () => {
    expect(dueFirstMessages([ready], { a: first })).toEqual([
      { workspaceId: "a", sessionId: "chat-a", first },
    ]);
  });

  it("honors a waiting plan in a local chat and drops it on a cloud delivery", () => {
    const planned = { ...first, model: "codex-app-server:gpt-6.1-sol", planMode: true };
    expect(dueFirstMessages([ready], { a: planned })[0].first.planMode).toBe(true);
    expect(dueFirstMessages([{ ...ready, kind: "cloud" }], { a: planned })[0].first.planMode).toBe(
      false
    );
  });

  it("drops a waiting plan when the first message opens a Gemini chat", () => {
    const queued = { ...first, model: "gemini:gemini-4-neon", planMode: true };
    expect(dueFirstMessages([ready], { a: queued })[0].first).toEqual({
      ...queued,
      planMode: false,
    });
  });

  it("goes to its own workspace, whichever others are ready", () => {
    const other = { ...ready, id: "b", current_session_id: "chat-b" };
    const second = { message: "add dark mode", model: "opus" };
    expect(dueFirstMessages([starting, other], { a: first, b: second })).toEqual([
      { workspaceId: "b", sessionId: "chat-b", first: second },
    ]);
    // A ready workspace nothing waits for gets nothing.
    expect(dueFirstMessages([ready, other], { b: second })).toHaveLength(1);
  });

  it("is never sent twice: not to a chat that has a message, or is answering one", () => {
    const spoken = { ...ready, latest_message_sent_at: "2026-11-12T10:00:00Z" };
    expect(dueFirstMessages([spoken], { a: first })).toEqual([]);
    expect(dueFirstMessages([{ ...ready, session_status: "working" }], { a: first })).toEqual([]);
  });
});

describe("a message for a workspace this host does not list", () => {
  it("is left alone: it may be another computer's, and due when the window switches back", () => {
    const elsewhere = { another: first };
    expect(dueFirstMessages([ready], elsewhere)).toEqual([]);
    expect(missedFirstMessages([ready], elsewhere)).toEqual([]);
    expect(dueFirstMessages([{ ...ready, id: "another" }], elsewhere)).toHaveLength(1);
  });
});

describe("a waiting message whose chat was spoken to first", () => {
  const spoken = { ...ready, latest_message_sent_at: "2026-11-12T10:00:00Z" };

  it("is missed: it goes to that chat, never as a send", () => {
    expect(missedFirstMessages([spoken], { a: first })).toEqual([
      { workspaceId: "a", sessionId: "chat-a", first },
    ]);
    expect(dueFirstMessages([spoken], { a: first })).toEqual([]);
  });

  it("is not missed while the workspace has no chat, or its chat has heard nothing", () => {
    expect(missedFirstMessages([starting], { a: first })).toEqual([]);
    expect(
      missedFirstMessages([{ ...starting, latest_message_sent_at: "2026-11-12T10:00:00Z" }], {
        a: first,
      })
    ).toEqual([]);
    expect(missedFirstMessages([ready], { a: first })).toEqual([]);
  });

  it("is only this workspace's: nothing waits, nothing is missed", () => {
    const other = { ...spoken, id: "b", current_session_id: "chat-b" };
    expect(missedFirstMessages([spoken, other], { a: first })).toEqual([
      { workspaceId: "a", sessionId: "chat-a", first },
    ]);
    expect(missedFirstMessages([spoken], {})).toEqual([]);
  });
});

describe("the first chat, whatever chat is current (H10)", () => {
  // Another chat (an agent's second opinion) was opened in the workspace before this client came back.
  const opened = {
    ...ready,
    current_session_id: "chat-second",
    session_status: "working",
    latest_message_sent_at: "2026-11-20T10:00:00Z",
    first_session_id: "chat-a",
    first_session_status: "idle",
    first_session_last_message_at: null,
  } as const;

  it("is sent to the first chat, by that chat's own state", () => {
    expect(dueFirstMessages([opened], { a: first })).toEqual([
      { workspaceId: "a", sessionId: "chat-a", first },
    ]);
    expect(missedFirstMessages([opened], { a: first })).toEqual([]);
  });

  it("goes to the first chat's composer when that chat was spoken to first", () => {
    const spoken = { ...opened, first_session_last_message_at: "2026-11-20T10:00:00Z" };
    expect(dueFirstMessages([spoken], { a: first })).toEqual([]);
    expect(missedFirstMessages([spoken], { a: first })).toEqual([
      { workspaceId: "a", sessionId: "chat-a", first },
    ]);
  });
});
