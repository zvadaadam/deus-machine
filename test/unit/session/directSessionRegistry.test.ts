import { describe, it, expect, vi } from "vitest";
import {
  registerDirectSession,
  getDirectSession,
  buildMessageSendFrame,
  buildCancelFrame,
  type DirectSessionChannel,
} from "@/features/session/cloud/directSessionRegistry";

const channel = (): DirectSessionChannel => ({
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  sendRaw: vi.fn(),
});

describe("directSessionRegistry", () => {
  it("round-trips register → get, and the disposer clears the entry", () => {
    const SESSION = "sess-reg-1";
    expect(getDirectSession(SESSION)).toBeUndefined();

    const ch = channel();
    const dispose = registerDirectSession(SESSION, ch);
    expect(getDirectSession(SESSION)).toBe(ch);

    dispose();
    expect(getDirectSession(SESSION)).toBeUndefined();
  });

  it("a stale disposer does NOT clear a replacement channel (fast remount)", () => {
    const SESSION = "sess-reg-2";
    const first = channel();
    const disposeFirst = registerDirectSession(SESSION, first);

    // A remount registers the replacement BEFORE the old effect's cleanup runs.
    const second = channel();
    registerDirectSession(SESSION, second);

    // The stale disposer must be a no-op — the live channel survives.
    disposeFirst();
    expect(getDirectSession(SESSION)).toBe(second);
  });
});

describe("buildMessageSendFrame", () => {
  it("builds the message.send frame with turn-id idempotency and the turn's selection", () => {
    const frame = buildMessageSendFrame("hello", "turn-1", {
      agentHarness: "claude-code",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
    });
    expect(frame).toEqual({
      type: "message.send",
      text: "hello",
      turnId: "turn-1",
      messageId: "turn-1",
      idempotencyKey: "turn-1", // == turnId, so a socket redelivery replays, not duplicates
      options: { harness: "claude-code", model: "claude-opus-4-8", thinkingLevel: "high" },
    });
  });

  it("names a codex turn's harness (agnt keys the credential lookup on it) and no credential", () => {
    const frame = buildMessageSendFrame("run", "turn-3", {
      agentHarness: "codex-app-server",
      model: "gpt-6.1-sol",
      // The platform's level; the local engine's vocabulary has no `ultra`.
      thinkingLevel: "ultra",
    });
    expect(frame.options).toEqual({
      harness: "codex-app-server",
      model: "gpt-6.1-sol",
      thinkingLevel: "ultra",
    });
  });

  it.each([
    [{ agentHarness: "claude-code", model: "opus", thinkingLevel: "" }, /thinking level/],
    [{ agentHarness: "claude-code", model: "", thinkingLevel: "high" }, /model/],
    // Claude's alias for the account's own default: AGNT runs no turn on it.
    [{ agentHarness: "claude-code", model: "default", thinkingLevel: "high" }, /model/],
    [{ agentHarness: "codex-sdk", model: "gpt-5", thinkingLevel: "low" }, /cloud workspaces/],
  ])("refuses a turn AGNT would refuse (%j) before anything is sent", (options, message) => {
    expect(() => buildMessageSendFrame("hi", "turn-5", options)).toThrow(message);
  });
});

describe("buildCancelFrame", () => {
  it("stamps the turn id when given (a late cancel targets the intended turn)", () => {
    expect(buildCancelFrame("turn-9")).toEqual({ type: "agent.cancel", turnId: "turn-9" });
  });

  it("omits turnId to cancel whatever turn is live", () => {
    expect(buildCancelFrame()).toEqual({ type: "agent.cancel" });
  });
});
