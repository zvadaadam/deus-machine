import { describe, it, expect, vi } from "vitest";
import {
  registerDirectSession,
  getDirectSession,
  buildMessageSendFrame,
  buildCancelFrame,
  type DirectSessionChannel,
} from "@/features/session/cloud/directSessionRegistry";

const channel = (): DirectSessionChannel => ({ sendMessage: vi.fn(), cancel: vi.fn() });

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
  it("builds the claude message.send frame with turn-id idempotency and no options when bare", () => {
    const frame = buildMessageSendFrame("hello", "turn-1", {});
    expect(frame).toEqual({
      type: "message.send",
      text: "hello",
      turnId: "turn-1",
      idempotencyKey: "turn-1", // == turnId, so a socket redelivery replays, not duplicates
    });
    // A bare claude send carries no options object at all.
    expect(frame.options).toBeUndefined();
  });

  it("always rides the harness on the wire (so a non-claude turn isn't run as claude)", () => {
    const frame = buildMessageSendFrame("hi", "turn-2", {
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      agentHarness: "claude-code",
    });
    expect(frame.options).toEqual({
      harness: "claude-code",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
    });
  });

  it("rides the harness on the wire for codex (agnt keys the credential lookup on it)", () => {
    const frame = buildMessageSendFrame("run", "turn-3", {
      agentHarness: "codex-app-server",
      model: "gpt-5",
    });
    expect(frame.options).toEqual({ harness: "codex-app-server", model: "gpt-5" });
  });

  it("NEVER puts a credential on the wire (agnt resolves the org key at dispatch)", () => {
    const frame = buildMessageSendFrame("secret?", "turn-4", {
      agentHarness: "codex-app-server",
      model: "gpt-5",
      thinkingLevel: "low",
    });
    const opts = (frame.options ?? {}) as Record<string, unknown>;
    expect(opts.apiKey).toBeUndefined();
    expect(opts.authKind).toBeUndefined();
    expect(opts.codexAuthJson).toBeUndefined();
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
