/**
 * Compaction placement.
 *
 * A compaction is a POSITIONAL entity (protocol §5): it renders between the
 * turn it fired during and that turn's successor, and a reload must land it in
 * the same slot the live stream did. These tests pin the anchor rules so the
 * divider can't drift to the bottom of the transcript.
 */
import { describe, expect, it } from "vitest";

import {
  compactionLabel,
  compactionTokenLabel,
  insertCompactions,
  type Turn,
} from "../../../apps/web/src/features/session/lib/chatTimeline";
import type { Compaction, Message } from "../../../shared/types/session";

function message(overrides: Partial<Message> & { id: string; turn_id: string }): Message {
  return {
    session_id: "session-1",
    seq: 0,
    role: "assistant",
    content: null,
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
    messages: [message({ id: `a-${turnId}`, turn_id: turnId, sent_at: sentAt })],
    firstMessageIndex: 0,
    isLatest: false,
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
        : `assistant:${item.messages[0].turn_id}`
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
