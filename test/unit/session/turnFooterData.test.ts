import { describe, expect, it } from "vitest";
import { getTurnFooterData } from "@/features/session/ui/utils/getTurnFooterData";
import type { Message } from "@/shared/types";

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? "message-1",
    session_id: "session-1",
    seq: overrides.seq ?? 1,
    role: overrides.role ?? "assistant",
    parts: overrides.parts,
    sent_at: overrides.sent_at ?? null,
    ...overrides,
  };
}

describe("getTurnFooterData", () => {
  it("shows recorded execution for an empty turn without inventing an account or default model", () => {
    const attribution = { execution: { harness: "codex-app-server" } };
    const result = getTurnFooterData([], undefined, { turnId: "turn", ...attribution });
    expect(result.attribution).toEqual(attribution);
    expect(result.attribution?.providerCredentialSource).toBeUndefined();
    expect(result.attribution?.execution?.model).toBeUndefined();
    expect(result.attribution?.execution?.thinkingLevel).toBeUndefined();
  });

  it("copies the latest text-bearing assistant message and uses the latest part end time", () => {
    const messages: Message[] = [
      createMessage({
        id: "message-1",
        sent_at: "2026-04-13T10:00:03.000Z",
        parts: [
          {
            type: "text",
            id: "part-1",
            sessionId: "session-1",
            messageId: "message-1",
            text: "Done.",
            state: "done",
          },
        ],
      }),
      createMessage({
        id: "message-2",
        sent_at: "2026-04-13T10:00:05.000Z",
        parts: [
          {
            type: "tool",
            id: "part-2",
            sessionId: "session-1",
            messageId: "message-2",
            toolCallId: "tool-1",
            toolName: "Read",
            state: {
              status: "completed",
              input: { file_path: "src/app.ts" },
              time: {
                start: 1776074404000,
                end: 1776074409000,
              },
            },
          },
        ],
      }),
    ];

    expect(getTurnFooterData(messages, "2026-04-13T10:00:00.000Z")).toEqual({
      copyText: "Done.",
      durationMs: 9000,
      tokens: null,
      cost: null,
    });
  });

  it("falls back to the last assistant sent_at when no part timings are available", () => {
    const messages: Message[] = [
      createMessage({
        id: "message-3",
        sent_at: "2026-04-13T10:00:06.000Z",
        parts: [
          {
            type: "text",
            id: "part-3",
            sessionId: "session-1",
            messageId: "message-3",
            text: "Short answer",
            state: "done",
          },
        ],
      }),
    ];

    expect(getTurnFooterData(messages, "2026-04-13T10:00:00.000Z")).toEqual({
      copyText: "Short answer",
      durationMs: 6000,
      tokens: null,
      cost: null,
    });
  });

  it("uses the turn end time for interrupted turns and omits invalid durations", () => {
    const messages: Message[] = [
      createMessage({
        id: "message-4",
        parts: [
          {
            type: "text",
            id: "part-4",
            sessionId: "session-1",
            messageId: "message-4",
            text: "Partial response",
            state: "done",
          },
        ],
      }),
    ];

    const turn = { turnId: "turn", endedAt: Date.parse("2026-04-13T10:00:08.000Z") };
    expect(getTurnFooterData(messages, "not-a-date", turn)).toEqual({
      copyText: "Partial response",
      durationMs: null,
      tokens: null,
      cost: null,
    });
    expect(getTurnFooterData(messages, "2026-04-13T10:00:00.000Z", turn)).toEqual({
      copyText: "Partial response",
      durationMs: 8000,
      tokens: null,
      cost: null,
    });
  });

  it("reads billing totals from the turn independently of its messages", () => {
    const messages: Message[] = [
      createMessage({ id: "message-1", sent_at: "2026-04-13T10:00:01.000Z" }),
      createMessage({
        id: "message-2",
        sent_at: "2026-04-13T10:00:02.000Z",
        parts: [
          {
            type: "text",
            id: "part-1",
            sessionId: "session-1",
            messageId: "message-2",
            text: "Done.",
            state: "done",
          },
        ],
      }),
    ];

    expect(
      getTurnFooterData(messages, "2026-04-13T10:00:00.000Z", {
        turnId: "turn",
        tokens: { input: 100, output: 20, cache: { read: 5, write: 1 } },
        cost: 0.0123,
      })
    ).toMatchObject({
      copyText: "Done.",
      tokens: { input: 100, output: 20, cache: { read: 5, write: 1 } },
      cost: 0.0123,
    });
  });

  it("distinguishes unknown usage from a reported zero", () => {
    expect(getTurnFooterData([], undefined, { turnId: "unknown" })).toMatchObject({
      tokens: null,
      cost: null,
    });
    expect(
      getTurnFooterData([], undefined, { turnId: "zero", tokens: { input: 0, output: 0 }, cost: 0 })
    ).toMatchObject({ tokens: { input: 0, output: 0 }, cost: 0 });
  });
});
