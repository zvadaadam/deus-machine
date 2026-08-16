/**
 * The adapter between the cached SQLite rows and the engine's read-only
 * projections.
 *
 * The three derivations it feeds — turn grouping, subagent nesting, the
 * activity indicator — used to be hand-written inside Chat.tsx and
 * SessionPanel.tsx, where they were untestable and untested. What is pinned
 * here is the ADAPTER plus the answers the selectors give for deus's row
 * shapes: the selectors themselves are the package's, and tested there.
 */

import { describe, expect, it } from "vitest";
import { agentActivity, groupIntoTurns, subagentGroups } from "@zvada/agent-server/protocol";
import { conversationView } from "../../../apps/web/src/features/session/lib/conversationView";
import type { Message } from "../../../shared/types/session";
import type { Part } from "../../../shared/protocol-types";

const SESSION = "sess-1";

function row(over: Partial<Message> & Pick<Message, "id" | "role">): Message {
  return {
    session_id: SESSION,
    seq: 0,
    turn_id: "t1",
    sent_at: "2026-08-15T10:00:00.000Z",
    parts: [],
    ...over,
  } as Message;
}

function text(id: string, messageId: string): Part {
  return { type: "text", id, sessionId: SESSION, messageId, text: "hi" } as Part;
}

function tool(id: string, messageId: string, status: string): Part {
  return {
    type: "tool",
    id,
    sessionId: SESSION,
    messageId,
    toolCallId: `call-${id}`,
    toolName: "Bash",
    state: { status, input: {}, time: { start: 0 } },
  } as unknown as Part;
}

describe("groupIntoTurns over cached rows", () => {
  it("gives each user message its own group and merges consecutive assistants", () => {
    const messages = [
      row({ id: "u1", role: "user" }),
      row({ id: "a1", role: "assistant" }),
      row({ id: "a2", role: "assistant" }),
      row({ id: "u2", role: "user", turn_id: "t2" }),
      row({ id: "a3", role: "assistant", turn_id: "t2" }),
    ];

    const groups = groupIntoTurns(conversationView(messages, false));

    expect(groups.map((g) => [g.role, g.entries.length])).toEqual([
      ["user", 1],
      ["assistant", 2],
      ["user", 1],
      ["assistant", 1],
    ]);
    // Groups stay in order, so each is a contiguous slice of the input — the
    // property Chat.tsx relies on instead of mapping entries back to rows.
    expect(
      groups.flatMap((g) => g.entries.map((e) => e.kind === "message" && e.messageId))
    ).toEqual(messages.map((m) => m.id));
  });

  it("splits two assistant messages that belong to different turns", () => {
    // The cancelled-turn marker row and the next turn's output are adjacent
    // when the next turn's echo has not landed yet. Grouping by role alone
    // merged them into one card under the wrong turn id.
    const groups = groupIntoTurns(
      conversationView(
        [
          row({ id: "cancelled-t1", role: "assistant", turn_id: "t1" }),
          row({ id: "a1", role: "assistant", turn_id: "t2" }),
        ],
        false
      )
    );

    expect(groups.map((g) => g.turnId)).toEqual(["t1", "t2"]);
  });

  it("marks ONLY the final group as latest", () => {
    // The guard that keeps a finished turn out of streaming mode: the instant
    // the next prompt's echo lands, the previous — completed — answer must
    // lose the flag, or it visibly reverts to "working".
    const streaming = groupIntoTurns(
      conversationView(
        [row({ id: "u1", role: "user" }), row({ id: "a1", role: "assistant" })],
        true
      )
    );
    expect(streaming.map((g) => g.isLatest)).toEqual([false, true]);

    const answered = groupIntoTurns(
      conversationView(
        [
          row({ id: "u1", role: "user" }),
          row({ id: "a1", role: "assistant" }),
          row({ id: "u2", role: "user", turn_id: "t2" }),
        ],
        true
      )
    );
    expect(answered.map((g) => g.isLatest)).toEqual([false, false, true]);
  });

  it("is empty for an empty page", () => {
    expect(groupIntoTurns(conversationView([], false))).toEqual([]);
    expect(conversationView([], true).turns).toEqual([]);
  });
});

describe("subagentGroups over cached rows", () => {
  it("keys parented messages by the tool call that spawned them", () => {
    const messages = [
      row({ id: "a1", role: "assistant" }),
      row({ id: "s1", role: "assistant", parent_tool_call_id: "task-1" }),
      row({ id: "s2", role: "assistant", parent_tool_call_id: "task-1" }),
      row({ id: "s3", role: "assistant", parent_tool_call_id: "task-2" }),
    ];

    const groups = subagentGroups(conversationView(messages, false));

    expect([...groups.keys()]).toEqual(["task-1", "task-2"]);
    expect(groups.get("task-1")!.map((m) => m.messageId)).toEqual(["s1", "s2"]);
  });
});

describe("agentActivity over cached rows", () => {
  const activityOf = (parts: Part[], working = true) =>
    agentActivity(
      conversationView(
        [row({ id: "u1", role: "user" }), row({ id: "a1", role: "assistant", parts })],
        working
      )
    );

  it("reads the last part of the last assistant message", () => {
    expect(activityOf([{ ...text("p1", "a1"), type: "reasoning" } as Part])).toBe("thinking");
    expect(activityOf([text("p1", "a1")])).toBe("generating");
    expect(activityOf([tool("p1", "a1", "in_progress")])).toBe("tool_running");
    expect(activityOf([tool("p1", "a1", "failed")])).toBe("tool_failed");
  });

  it("is idle between activities — a completed tool says nothing about what is next", () => {
    expect(activityOf([tool("p1", "a1", "completed")])).toBe("idle");
  });

  it("is idle when the session is not working, whatever the last part was", () => {
    // No ACTIVE turn to read: `conversationView` marks the last turn ended.
    expect(activityOf([tool("p1", "a1", "in_progress")], false)).toBe("idle");
  });

  it("ignores subagent output — the main thread's activity is the tool call", () => {
    const messages = [
      row({ id: "a1", role: "assistant", parts: [tool("p1", "a1", "in_progress")] }),
      row({
        id: "s1",
        role: "assistant",
        parent_tool_call_id: "call-p1",
        parts: [text("sp1", "s1")],
      }),
    ];

    expect(agentActivity(conversationView(messages, true))).toBe("tool_running");
  });
});
