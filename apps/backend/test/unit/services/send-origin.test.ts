// Who sent a message reaches the engine from the operator's host only: a
// client's send carries none, and the person's own is never marked.
import { describe, expect, it } from "vitest";
import * as sessions from "@shared/api/sessions";
import { buildTurnStartParams } from "../../../src/services/agent/run-config";

const send = {
  sessionId: "s1",
  content: "hi",
  model: "opus",
  agentHarness: "claude-code",
};

describe("a message's origin", () => {
  it("is not taken from a client's input", () => {
    const parsed = sessions.sendMessage.input.parse({
      ...send,
      origin: { kind: "session", sessionId: "forged" },
    });
    expect(parsed).not.toHaveProperty("origin");
  });

  it("reaches turn/start when the host gives one, and never for the person", () => {
    const origin = { kind: "session" as const, sessionId: "lead", name: "deus/voyager:1" };
    const base = { cwd: "/tmp" };
    expect(
      buildTurnStartParams("s1", "t1", "claude-code", "hi", { ...base, origin }).origin
    ).toEqual(origin);
    expect(
      buildTurnStartParams("s1", "t1", "claude-code", "hi", { ...base, origin: { kind: "person" } })
    ).not.toHaveProperty("origin");
    expect(buildTurnStartParams("s1", "t1", "claude-code", "hi", base)).not.toHaveProperty(
      "origin"
    );
  });
});
