import { describe, it, expect } from "vitest";
import { serverFrameSchema, clientAuthFrameSchema, pairerFrameSchema } from "../src/schemas";

describe("serverFrameSchema", () => {
  it("parses valid register frame", () => {
    const result = serverFrameSchema.safeParse({
      type: "register",
      serverId: "abc123",
      relayToken: "tok_abc",
    });
    expect(result.success).toBe(true);
  });

  it("parses register frame with optional serverName", () => {
    const result = serverFrameSchema.safeParse({
      type: "register",
      serverId: "abc123",
      relayToken: "tok_abc",
      serverName: "My Server",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.serverName).toBe("My Server");
  });

  it("parses valid data frame", () => {
    const result = serverFrameSchema.safeParse({
      type: "data",
      clientId: "client-1",
      payload: '{"msg":"hello"}',
    });
    expect(result.success).toBe(true);
  });

  it("parses auth_response with allowed=true", () => {
    const result = serverFrameSchema.safeParse({
      type: "auth_response",
      clientId: "client-1",
      allowed: true,
    });
    expect(result.success).toBe(true);
  });

  it("parses auth_response with allowed=false and reason", () => {
    const result = serverFrameSchema.safeParse({
      type: "auth_response",
      clientId: "client-1",
      allowed: false,
      reason: "Invalid token",
    });
    expect(result.success).toBe(true);
  });

  it("parses pair_response with success=true", () => {
    const result = serverFrameSchema.safeParse({
      type: "pair_response",
      pairId: "pair-1",
      success: true,
      deviceToken: "dev_tok",
    });
    expect(result.success).toBe(true);
  });

  it("parses pair_response with success=false", () => {
    const result = serverFrameSchema.safeParse({
      type: "pair_response",
      pairId: "pair-1",
      success: false,
      reason: "Bad code",
    });
    expect(result.success).toBe(true);
  });

  it("rejects pair_response with success=true but no deviceToken", () => {
    const result = serverFrameSchema.safeParse({
      type: "pair_response",
      pairId: "pair-1",
      success: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects pair_response with success=false but no reason", () => {
    const result = serverFrameSchema.safeParse({
      type: "pair_response",
      pairId: "pair-1",
      success: false,
    });
    expect(result.success).toBe(false);
  });

  it("parses pong frame", () => {
    const result = serverFrameSchema.safeParse({ type: "pong" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown frame type", () => {
    const result = serverFrameSchema.safeParse({ type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("rejects register frame missing relayToken", () => {
    const result = serverFrameSchema.safeParse({
      type: "register",
      serverId: "abc123",
    });
    expect(result.success).toBe(false);
  });
});

describe("clientAuthFrameSchema", () => {
  it("parses valid authenticate frame", () => {
    const result = clientAuthFrameSchema.safeParse({
      type: "authenticate",
      token: "dev_tok_123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects frame with wrong type", () => {
    const result = clientAuthFrameSchema.safeParse({
      type: "login",
      token: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects frame missing token", () => {
    const result = clientAuthFrameSchema.safeParse({
      type: "authenticate",
    });
    expect(result.success).toBe(false);
  });
});

describe("pairerFrameSchema", () => {
  it("parses valid pair_request", () => {
    const result = pairerFrameSchema.safeParse({
      type: "pair_request",
      code: "EAGLE",
      deviceName: "iPad Pro",
    });
    expect(result.success).toBe(true);
  });

  it("applies default deviceName", () => {
    const result = pairerFrameSchema.safeParse({
      type: "pair_request",
      code: "CLOUD",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.deviceName).toBe("Web Browser");
  });
});
