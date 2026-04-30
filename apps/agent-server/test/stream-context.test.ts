import { describe, it, expect } from "vitest";
import { createStreamContext } from "../agents/claude/stream-context";

describe("StreamContext", () => {
  describe("createStreamContext", () => {
    it("returns zeroed context", () => {
      const ctx = createStreamContext();
      expect(ctx.querySucceeded).toBe(false);
      expect(ctx.stopReasonError).toBe(false);
      expect(ctx.messageCount).toBe(0);
      expect(ctx.lastResultError).toBeNull();
      expect(ctx.firstMessageTime).toBeNull();
    });
  });
});
