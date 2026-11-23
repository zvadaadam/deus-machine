/**
 * Compaction placement.
 *
 * A completed compaction follows its settled turn in both live and reloaded transcripts.
 */
import { describe, expect, it } from "vitest";

import {
  buildChatTimeline,
  compactionLabel,
  compactionTokenLabel,
  insertCompactions,
  turnStopNotice,
  type AssistantTurnData,
  type Turn,
} from "../../../apps/web/src/features/session/lib/chatTimeline";
import { createOptimisticUserMessage } from "../../../apps/web/src/features/session/lib/optimisticMessage";
import type { Compaction, Message } from "../../../shared/types/session";

function message(overrides: Partial<Message> & { id: string; turn_id: string }): Message {
  return {
    session_id: "session-1",
    seq: 0,
    role: "assistant",
    sent_at: "2026-08-14T10:00:00.000Z",
    ...overrides,
  };
}

function userTurn(turnId: string, sentAt: string): Turn {
  return {
    type: "user",
    message: message({ id: `u-${turnId}`, turn_id: turnId, role: "user", sent_at: sentAt }),
    messageIndex: 0,
  };
}

function assistantTurn(turnId: string, sentAt: string): Turn {
  return {
    type: "assistant",
    turnId,
    messages: [message({ id: `a-${turnId}`, turn_id: turnId, sent_at: sentAt })],
    isStreaming: false,
    startedAt: sentAt,
  };
}

function compaction(overrides: Partial<Compaction> & { turn_id: string }): Compaction {
  return {
    compaction_id: `c-${overrides.turn_id}`,
    session_id: "session-1",
    status: "completed",
    created_at: "2026-08-14T10:00:00.000Z",
    ...overrides,
  };
}

/** Render order as a compact, readable string. */
function shape(items: ReturnType<typeof insertCompactions>): string[] {
  return items.map((item) =>
    item.type === "compaction"
      ? `compaction:${item.compaction.compaction_id}`
      : item.type === "user"
        ? `user:${item.message.turn_id}`
        : item.type === "assistant"
          ? `assistant:${item.turnId}`
          : "cloudEnv"
  );
}

describe("insertCompactions", () => {
  const turns: Turn[] = [
    userTurn("t1", "2026-08-14T10:00:00.000Z"),
    assistantTurn("t1", "2026-08-14T10:00:05.000Z"),
    userTurn("t2", "2026-08-14T10:01:00.000Z"),
    assistantTurn("t2", "2026-08-14T10:01:05.000Z"),
  ];

  it("returns the turn list untouched when there are no compactions", () => {
    expect(insertCompactions(turns, [])).toBe(turns);
  });

  it("places a marker after the LAST turn holding its turn_id, not the first", () => {
    const items = insertCompactions(turns, [compaction({ turn_id: "t1" })]);
    expect(shape(items)).toEqual([
      "user:t1",
      "assistant:t1",
      "compaction:c-t1",
      "user:t2",
      "assistant:t2",
    ]);
  });

  it("places a marker for the newest turn at the end of the transcript", () => {
    const items = insertCompactions(turns, [compaction({ turn_id: "t2" })]);
    expect(shape(items).at(-1)).toBe("compaction:c-t2");
  });

  it("keeps multiple markers on one turn in created_at order", () => {
    const items = insertCompactions(turns, [
      compaction({
        compaction_id: "second",
        turn_id: "t1",
        created_at: "2026-08-14T10:00:09.000Z",
      }),
      compaction({ compaction_id: "first", turn_id: "t1", created_at: "2026-08-14T10:00:04.000Z" }),
    ]);
    expect(shape(items)).toEqual([
      "user:t1",
      "assistant:t1",
      "compaction:first",
      "compaction:second",
      "user:t2",
      "assistant:t2",
    ]);
  });

  it("falls back to created_at when the marker's turn has no loaded messages", () => {
    // t-gone was paginated away / the marker beat its turn's first message.
    const items = insertCompactions(turns, [
      compaction({ turn_id: "t-gone", created_at: "2026-08-14T10:00:30.000Z" }),
    ]);
    expect(shape(items)).toEqual([
      "user:t1",
      "assistant:t1",
      "compaction:c-t-gone",
      "user:t2",
      "assistant:t2",
    ]);
  });

  it("hoists a marker older than every loaded turn above the first turn", () => {
    const items = insertCompactions(turns, [
      compaction({ turn_id: "t-ancient", created_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    expect(shape(items)[0]).toBe("compaction:c-t-ancient");
  });

  it("renders in-progress and failed compactions, drops cancelled ones", () => {
    const items = insertCompactions(turns, [
      compaction({ compaction_id: "running", turn_id: "t1", status: "in_progress" }),
      compaction({ compaction_id: "broken", turn_id: "t1", status: "failed" }),
      compaction({ compaction_id: "aborted", turn_id: "t1", status: "cancelled" }),
    ]);
    const rendered = shape(items).filter((s) => s.startsWith("compaction:"));
    expect(rendered).toEqual(["compaction:running", "compaction:broken"]);
  });

  it("returns the turn list untouched when every marker is dropped", () => {
    const items = insertCompactions(turns, [compaction({ turn_id: "t1", status: "cancelled" })]);
    expect(items).toBe(turns);
  });

  it("still renders markers when no turns are loaded at all", () => {
    expect(shape(insertCompactions([], [compaction({ turn_id: "t1" })]))).toEqual([
      "compaction:c-t1",
    ]);
  });
});

describe("compactionLabel", () => {
  it("distinguishes automatic from manual compaction", () => {
    expect(compactionLabel(compaction({ turn_id: "t1", trigger: "auto" }))).toBe("Auto-compacted");
    expect(compactionLabel(compaction({ turn_id: "t1", trigger: "manual" }))).toBe("Compacted");
    expect(compactionLabel(compaction({ turn_id: "t1" }))).toBe("Compacted");
  });

  it("never claims success for an in-flight or failed compaction", () => {
    expect(compactionLabel(compaction({ turn_id: "t1", status: "in_progress" }))).toBe(
      "Compacting"
    );
    expect(compactionLabel(compaction({ turn_id: "t1", status: "failed" }))).toBe(
      "Compaction failed"
    );
  });

  it("reads an unknown (open enum) status as the completed case", () => {
    expect(
      compactionLabel(compaction({ turn_id: "t1", status: "_partial", trigger: "auto" }))
    ).toBe("Auto-compacted");
  });
});

describe("compactionTokenLabel", () => {
  it("formats the before → after context size", () => {
    const c = compaction({ turn_id: "t1", pre_tokens: 78_000, post_tokens: 31_000 });
    expect(compactionTokenLabel(c)).toBe("78k → 31k tokens");
  });

  it("keeps small counts exact and abbreviates millions", () => {
    expect(
      compactionTokenLabel(compaction({ turn_id: "t1", pre_tokens: 950, post_tokens: 120 }))
    ).toBe("950 → 120 tokens");
    expect(
      compactionTokenLabel(
        compaction({ turn_id: "t1", pre_tokens: 1_200_000, post_tokens: 40_000 })
      )
    ).toBe("1.2M → 40k tokens");
  });

  it("returns null when the engine did not report token counts", () => {
    expect(compactionTokenLabel(compaction({ turn_id: "t1" }))).toBeNull();
    expect(compactionTokenLabel(compaction({ turn_id: "t1", pre_tokens: 78_000 }))).toBeNull();
  });
});

// ===========================================================================
// The whole derivation, out of React
// ===========================================================================

describe("buildChatTimeline", () => {
  const withText = (over: Partial<Message> & { id: string; turn_id: string }): Message =>
    message({
      parts: [
        {
          type: "text",
          id: `p-${over.id}`,
          sessionId: "session-1",
          messageId: over.id,
          text: "hi",
          state: "done",
        },
      ],
      ...over,
    });

  const assistantIds = (item: Turn | { type: "compaction" }): string[] =>
    (item as AssistantTurnData).messages.map((m) => m.id);

  const prompt = withText({
    id: "u-1",
    turn_id: "turn-1",
    role: "user",
    sent_at: "2026-08-14T10:00:00.000Z",
  });
  const reply = withText({ id: "a-1", turn_id: "turn-1", sent_at: "2026-08-14T10:00:05.000Z" });

  it("keeps the original clock and places the footer after a steer with no further reply", () => {
    const steer = withText({
      id: "steer",
      turn_id: "turn-1",
      role: "user",
      sent_at: "2026-08-14T10:00:06.000Z",
    });
    const rows = [prompt, reply, steer];
    expect(buildChatTimeline(rows, [], true).activeStartedAt).toBe(prompt.sent_at);
    const record = { turnId: "turn-1", stopReason: "error" };
    const { items } = buildChatTimeline(rows, [], false, [], [record]);
    expect(items).toMatchObject([
      { type: "user", message: prompt },
      { type: "assistant", messages: [reply], footerMessages: undefined },
      { type: "user", message: steer },
      {
        type: "assistant",
        record,
        messages: [],
        footerMessages: [reply],
        startedAt: prompt.sent_at,
      },
    ]);
  });

  it("keeps the recorded turn open while a new send's bubble is pending", () => {
    const pending = createOptimisticUserMessage({
      sessionId: reply.session_id,
      turnId: "pending",
      content: "Another question",
    });
    const { items } = buildChatTimeline(
      [reply, pending],
      [compaction({ turn_id: "turn-1" })],
      true,
      [],
      [{ turnId: "turn-1", startedAt: 1 }]
    );
    expect(items).toMatchObject([
      { type: "assistant", turnId: "turn-1", footerMessages: undefined, isStreaming: false },
      { type: "user", message: { id: pending.id } },
    ]);
  });

  it("holds a completed compaction before the running turn has a message", () => {
    const { items } = buildChatTimeline(
      [],
      [compaction({ turn_id: "turn-1" })],
      true,
      [],
      [{ turnId: "turn-1", startedAt: 1 }]
    );
    expect(items).toEqual([]);
  });

  it("holds the newest message's divider before its first part arrives", () => {
    const shell = message({ id: "a-2", turn_id: "turn-2", parts: [] });
    const marker = compaction({ turn_id: "turn-2" });
    const { items } = buildChatTimeline(
      [reply, shell],
      [marker],
      false,
      [],
      [
        { turnId: "turn-2", startedAt: 2 },
        { turnId: "turn-1", endedAt: 1 },
      ]
    );
    expect(items).toMatchObject([{ type: "assistant", turnId: "turn-1", footerMessages: [reply] }]);
  });

  it("shows the earlier turn's footer and divider after a later turn settles without reading its activity", () => {
    const later = withText({ id: "a-2", turn_id: "turn-2" });
    const marker = compaction({ turn_id: "turn-1" });
    const timeline = buildChatTimeline(
      [reply, later],
      [marker],
      true,
      [],
      [
        { turnId: "no-output", startedAt: 1 },
        { turnId: "turn-1", startedAt: 2 },
        { turnId: "turn-2", endedAt: 3 },
      ]
    );
    expect(timeline).toMatchObject({
      activity: "idle",
      items: [
        { type: "assistant", turnId: "turn-1", footerMessages: [reply] },
        { type: "compaction", compaction: marker },
        { type: "assistant", turnId: "turn-2", footerMessages: [later] },
      ],
    });
  });

  it("tells how the workspace started under the message that asked for it", () => {
    const start = {
      phase: "ready" as const,
      cloud: false,
      summary: "Workspace ready",
      steps: [],
      brief: null,
    };

    const { items, spacings } = buildChatTimeline([prompt, reply], [], false, [], [], start);

    expect(items.map((item) => item.type)).toEqual(["user", "start", "assistant"]);
    expect(items[1]).toEqual({ type: "start", start });
    expect(spacings).toHaveLength(3);
    // With nothing said yet it is still a transcript: the start line, not the empty state.
    expect(buildChatTimeline([], [], false, [], [], start).items).toEqual([
      { type: "start", start },
    ]);
    expect(buildChatTimeline([prompt], [], false).items.map((item) => item.type)).toEqual(["user"]);
  });

  it("puts a cloud computer's provisioning under the first message that was waiting for it", () => {
    // Provisioned before the message could be sent: older than every turn.
    const provisioning = {
      id: 1,
      status: "running",
      step: null,
      reason: null,
      snapshotRestored: false,
      at: Date.parse("2026-08-14T09:59:00.000Z"),
    };

    const { items } = buildChatTimeline([prompt, reply], [], false, [provisioning]);

    expect(items.map((item) => item.type)).toEqual(["user", "cloudEnv", "assistant"]);
    // In a chat with nothing said yet, it is simply first.
    expect(buildChatTimeline([], [], false, [provisioning]).items.map((item) => item.type)).toEqual(
      ["cloudEnv"]
    );
  });

  it("keeps a wake where it happened: after the send that caused it", () => {
    const followUp = withText({
      id: "u-2",
      turn_id: "turn-2",
      role: "user",
      sent_at: "2026-08-14T11:00:00.000Z",
    });
    const wake = {
      id: 2,
      status: "resuming",
      step: null,
      reason: null,
      snapshotRestored: false,
      at: Date.parse("2026-08-14T11:00:01.000Z"),
    };

    const { items } = buildChatTimeline([prompt, reply, followUp], [], false, [wake]);

    expect(items.map((item) => item.type)).toEqual(["user", "assistant", "user", "cloudEnv"]);
  });

  it("groups consecutive rows into turns, each holding exactly its own messages", () => {
    const { items } = buildChatTimeline(
      [
        withText({ id: "u1", turn_id: "t1", role: "user" }),
        withText({ id: "a1", turn_id: "t1" }),
        withText({ id: "a2", turn_id: "t1" }),
        withText({ id: "u2", turn_id: "t2", role: "user" }),
        withText({ id: "a3", turn_id: "t2" }),
      ],
      [],
      false
    );

    expect(shape(items)).toEqual(["user:t1", "assistant:t1", "user:t2", "assistant:t2"]);
    expect(assistantIds(items[1])).toEqual(["a1", "a2"]);
    expect(assistantIds(items[3])).toEqual(["a3"]);
  });

  it("a filtered-out row never shifts a turn's slice", () => {
    // The invariant that used to be a comment inside the component: each group
    // is a contiguous slice of the RENDERED rows, so anything dropped before
    // grouping — a subagent child (it renders nested under its Task block) or
    // a part-less shell whose parts have not landed — must not offset the
    // slices that follow it.
    const { items } = buildChatTimeline(
      [
        withText({ id: "u1", turn_id: "t1", role: "user" }),
        withText({ id: "sub", turn_id: "t1", parent_tool_call_id: "task-1" }),
        message({ id: "shell", turn_id: "t1", parts: [] }),
        withText({ id: "a1", turn_id: "t1" }),
        withText({ id: "u2", turn_id: "t2", role: "user" }),
        withText({ id: "a2", turn_id: "t2" }),
      ],
      [],
      false
    );

    expect(shape(items)).toEqual(["user:t1", "assistant:t1", "user:t2", "assistant:t2"]);
    expect(assistantIds(items[1])).toEqual(["a1"]);
    expect(assistantIds(items[3])).toEqual(["a2"]);
  });

  it("renders an empty cancelled turn and its spacing without a message row", () => {
    const { items, spacings, activity, lastRole } = buildChatTimeline(
      [withText({ id: "u1", turn_id: "t1", role: "user" })],
      [],
      false,
      [],
      [{ turnId: "t1", stopReason: "cancelled", endedAt: Date.parse("2026-08-14T10:00:01Z") }]
    );
    expect(shape(items)).toEqual(["user:t1", "assistant:t1"]);
    expect(assistantIds(items[1])).toEqual([]);
    expect(spacings).toHaveLength(items.length);
    expect(lastRole).toBe("assistant");
    expect(activity).toBe("idle");
  });

  it.each([
    "refusal",
    "max_tokens",
    "max_turn_requests",
    "error",
    "end_turn",
    "_adapter_extension",
  ])("preserves an empty %s outcome independently of a part-less shell", (reason) => {
    const { items } = buildChatTimeline(
      [
        withText({ id: "u1", turn_id: "t1", role: "user" }),
        message({ id: "a1", turn_id: "t1", parts: [] }),
      ],
      [],
      false,
      [],
      [{ turnId: "t1", stopReason: reason }]
    );
    expect(shape(items)).toEqual(["user:t1", "assistant:t1"]);
    expect(assistantIds(items[1])).toEqual([]);
    expect(items[1]).toMatchObject({ record: { turnId: "t1", stopReason: reason } });
  });

  it("keeps turn identity and ordering when a late response fills an empty outcome", () => {
    const prompt = withText({ id: "u1", turn_id: "t1", role: "user" });
    const nextPrompt = withText({ id: "u2", turn_id: "t2", role: "user" });
    const nextAnswer = withText({ id: "a2", turn_id: "t2" });
    const records = [{ turnId: "t1", stopReason: "refusal", cost: 0.5 }];
    const empty = buildChatTimeline([prompt, nextPrompt, nextAnswer], [], false, [], records);
    const recovered = buildChatTimeline(
      [prompt, withText({ id: "a1", turn_id: "t1" }), nextPrompt, nextAnswer],
      [],
      false,
      [],
      records
    );
    expect(shape(empty.items)).toEqual(["user:t1", "assistant:t1", "user:t2", "assistant:t2"]);
    expect(shape(recovered.items)).toEqual(shape(empty.items));
    expect(assistantIds(empty.items[1])).toEqual([]);
    expect(assistantIds(recovered.items[1])).toEqual(["a1"]);
    expect(assistantIds(recovered.items[3])).toEqual(["a2"]);
    expect(empty.items[1]).toMatchObject({ turnId: "t1", record: records[0], isStreaming: false });
    expect(recovered.items[1]).toMatchObject({
      turnId: "t1",
      record: records[0],
      isStreaming: false,
    });
  });

  it("does not turn a completed outcome back into the latest response after a new prompt", () => {
    const { items } = buildChatTimeline(
      [
        withText({ id: "u1", turn_id: "t1", role: "user" }),
        withText({ id: "u2", turn_id: "t2", role: "user" }),
      ],
      [],
      true,
      [],
      [
        { turnId: "t1", stopReason: "error" },
        { turnId: "t2", startedAt: 1 },
      ]
    );
    expect(shape(items)).toEqual(["user:t1", "assistant:t1", "user:t2"]);
    expect(items[1]).toMatchObject({ isStreaming: false });
  });

  it("anchors a truly message-less outcome and its compaction by turn identity", () => {
    const { items } = buildChatTimeline(
      [],
      [compaction({ turn_id: "t1" })],
      false,
      [],
      [{ turnId: "t1", stopReason: "error" }]
    );
    expect(shape(items)).toEqual(["assistant:t1", "compaction:c-t1"]);
  });
});

describe("turnStopNotice", () => {
  it("explains known abnormal outcomes", () => {
    for (const reason of ["refusal", "max_tokens", "max_turn_requests", "error"]) {
      expect(turnStopNotice(reason)).toBeTruthy();
    }
  });

  it("stays silent for the ordinary ending, cancellation badge, and unknowns", () => {
    // Stop reasons are an OPEN vocabulary — a newer engine's value reaches
    // this build unchanged and must not be given invented copy.
    for (const reason of ["end_turn", "cancelled", "_adapter_extension", null, undefined]) {
      expect(turnStopNotice(reason)).toBeNull();
    }
  });
});

it("holds the active turn's completed compactions through a disconnect until success or stop", () => {
  const rows = ["earlier", "active"].map((turn_id) =>
    message({
      id: turn_id,
      turn_id,
      parts: [
        {
          id: turn_id,
          type: "text",
          sessionId: "session-1",
          messageId: turn_id,
          text: turn_id,
          state: "done",
        },
      ],
    })
  );
  const markers = [
    compaction({ turn_id: "earlier" }),
    compaction({ turn_id: "active", compaction_id: "first" }),
    compaction({ turn_id: "active", compaction_id: "second" }),
    compaction({ turn_id: "active", compaction_id: "running", status: "in_progress" }),
    compaction({ turn_id: "active", compaction_id: "failed", status: "failed" }),
  ];
  const result = buildChatTimeline(rows, markers, true);
  expect(shape(result.items)).toEqual([
    "assistant:earlier",
    "compaction:c-earlier",
    "assistant:active",
    "compaction:running",
    "compaction:failed",
  ]);
  const disconnected = buildChatTimeline(
    rows,
    markers,
    false,
    [],
    [{ turnId: "active", startedAt: 1 }]
  );
  expect(shape(disconnected.items)).toEqual(shape(result.items));
  for (const stopReason of ["end_turn", "cancelled"]) {
    const settled = buildChatTimeline(rows, markers, true, [], [{ turnId: "active", stopReason }]);
    expect(shape(settled.items).slice(3)).toEqual([
      "compaction:first",
      "compaction:second",
      "compaction:running",
      "compaction:failed",
    ]);
  }
});
