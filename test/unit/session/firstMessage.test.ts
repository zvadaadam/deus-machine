import { describe, expect, it } from "vitest";
import { dueFirstMessages, missedFirstMessages } from "@/features/session/lib/firstMessage";

const first = { message: "fix the login page", model: "opus" };
const starting = {
  id: "a",
  state: "initializing",
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
