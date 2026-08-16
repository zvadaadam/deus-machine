/**
 * The optimistic user bubble IS the engine's echo, predicted early.
 *
 * That only holds if the frontend and the backend agree, for every possible
 * `content` string, on the one question deus's wire cannot answer for them:
 * is this JSON-encoded `PartInput[]`, or is it prose that happens to start
 * with `[`? The backend asks the engine's `parseAgentInput`; the frontend used
 * to ask a looser hand-rolled predicate ("every entry is an object with a
 * string `type`"), which accepted arrays the schema rejects.
 *
 * When they disagree, nothing reconciles it. The bubble renders the loose
 * reading while the echo carries the strict one, both under `echo-${turnId}` —
 * the id upsert swaps the content out from under the user mid-turn.
 *
 * So these tests do not assert the frontend against a hand-written expectation
 * of the backend. They run BOTH functions and require the same answer.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUserEchoParts } from "@zvada/agent-server/protocol/factories";
import { createOptimisticUserMessage } from "@/features/session/lib/optimisticMessage";
import { toEngineInput } from "../../../apps/backend/src/services/agent/run-config";

const TURN = "01932f00-0000-7000-8000-000000000001";

// toEngineInput warns on every near-miss it downgrades to text — expected here,
// since near-misses are most of what this suite feeds it.
beforeAll(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));
afterAll(() => void vi.restoreAllMocks());

/** The parts the engine will emit for this send, derived the backend's way. */
const echoParts = (content: string) => createUserEchoParts(toEngineInput(content), TURN);

const optimisticParts = (content: string) =>
  createOptimisticUserMessage({ sessionId: "s1", turnId: TURN, content }).parts;

describe("createOptimisticUserMessage", () => {
  it("carries the echo's id and turn id", () => {
    const msg = createOptimisticUserMessage({ sessionId: "s1", turnId: TURN, content: "hi" });
    expect(msg.id).toBe(`echo-${TURN}`);
    expect(msg.turn_id).toBe(TURN);
    expect(msg.role).toBe("user");
  });

  it.each([
    ["plain prose", "hello there"],
    ["a markdown link at the start", "[see this](https://example.com) please"],
    ["an unparseable bracket", "[not json"],
    ["a JSON array of numbers", "[1, 2, 3]"],
    ["a JSON array of strings", '["just", "strings"]'],
    ["an empty array", "[]"],
    // The regression. `[{"type":"text"}]` has a string `type` and so passed
    // the old frontend predicate, but TextPartInput requires a non-empty
    // `text` — the backend sends it as TEXT. The bubble used to render one
    // part with `text: undefined` while the echo carried the literal JSON.
    ["a literal part-shaped JSON the schema rejects", '[{"type":"text"}]'],
    ["a part with an unknown type", '[{"type":"nope","text":"x"}]'],
    ["an image part missing its payload", '[{"type":"image","mimeType":"image/png"}]'],
    ["a text part with an empty string", '[{"type":"text","text":""}]'],
    // Genuinely structured sends must still be recognised as structured.
    ["a real text part", '[{"type":"text","text":"look at this"}]'],
    [
      "a real multimodal send",
      JSON.stringify([
        { type: "text", text: "what is this?" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
      ]),
    ],
  ])("predicts the echo byte for byte: %s", (_label, content) => {
    expect(optimisticParts(content)).toEqual(echoParts(content));
  });

  it("sends schema-rejected part-shaped JSON as ONE text part holding the literal input", () => {
    // Spelled out, because "equals the echo" would also be satisfied if both
    // sides were wrong in the same way.
    const content = '[{"type":"text"}]';
    expect(optimisticParts(content)).toEqual([
      expect.objectContaining({ type: "text", text: content, state: "done" }),
    ]);
  });

  it("keeps every part of a real multimodal send", () => {
    const content = JSON.stringify([
      { type: "text", text: "what is this?" },
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
    const parts = optimisticParts(content);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: "what is this?" });
    expect(parts[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "aGk=" });
  });
});
