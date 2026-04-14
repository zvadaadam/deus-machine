import { describe, it, expect } from "vitest";
import { classifyError, classifyStopReason, type ClassifiedError } from "../agents/lifecycle";

describe("classifyError", () => {
  // ── Abort ──────────────────────────────────────────────────────────────

  describe("abort", () => {
    it("classifies AbortError by name", () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      const result = classifyError(err);
      expect(result.category).toBe("abort");
    });

    it("classifies error with 'aborted' in message", () => {
      const err = new Error("Request aborted by user");
      const result = classifyError(err);
      expect(result.category).toBe("abort");
    });
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  describe("auth", () => {
    it.each([
      ["401 errors", "HTTP 401 Unauthorized"],
      ["403 errors", "HTTP 403 Forbidden"],
      ["invalid API key", "Invalid API key provided"],
      ["invalid x-api-key", "Invalid x-api-key header"],
      ["authentication failure", "Authentication failed"],
    ])("classifies %s", (_label, message) => {
      const result = classifyError(new Error(message));
      expect(result.category).toBe("auth");
    });
  });

  // ── Rate Limit ─────────────────────────────────────────────────────────

  describe("rate_limit", () => {
    it.each([
      ["429 errors", "HTTP 429 Too Many Requests"],
      ["rate limit messages", "Rate limit exceeded"],
      ["overloaded errors", "Server overloaded, please try again"],
    ])("classifies %s", (_label, message) => {
      const result = classifyError(new Error(message));
      expect(result.category).toBe("rate_limit");
    });
  });

  // ── Context Limit ──────────────────────────────────────────────────────

  describe("context_limit", () => {
    it.each([
      ["context length exceeded", "Context length exceeded"],
      ["context limit errors", "Context limit reached"],
    ])("classifies %s", (_label, message) => {
      const result = classifyError(new Error(message));
      expect(result.category).toBe("context_limit");
    });
  });

  // ── Network ────────────────────────────────────────────────────────────

  describe("network", () => {
    it.each([
      ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"],
      ["ETIMEDOUT", "connect ETIMEDOUT"],
      ["DNS errors", "getaddrinfo DNS resolution failed"],
    ])("classifies %s", (_label, message) => {
      const result = classifyError(new Error(message));
      expect(result.category).toBe("network");
    });

    it("classifies fetch TypeError", () => {
      const err = new TypeError("fetch failed");
      const result = classifyError(err);
      expect(result.category).toBe("network");
    });
  });

  // ── DB Write ───────────────────────────────────────────────────────────

  describe("db_write", () => {
    it.each([
      ["database locked", "SQLITE_BUSY: database is locked"],
      ["readonly database", "SQLITE_READONLY: attempt to write a readonly database"],
      ["'database is busy'", "database is busy"],
    ])("classifies %s as db_write", (_label, message) => {
      const result = classifyError(new Error(message));
      expect(result.category).toBe("db_write");
    });

    it("does NOT classify API 'Server is busy' as db_write", () => {
      const result = classifyError(new Error("Server is busy, please retry later"));
      expect(result.category).not.toBe("db_write");
    });
  });

  // ── Invalid Request ────────────────────────────────────────────────────

  describe("invalid_request", () => {
    it("classifies invalid request errors", () => {
      const result = classifyError(new Error("Invalid request parameters"));
      expect(result.category).toBe("invalid_request");
    });
  });

  // ── Process Exit ──────────────────────────────────────────────────────

  describe("process_exit", () => {
    it.each([
      ["'exited with code' errors", "Claude Code process exited with code 1"],
      ["'terminated by signal' errors", "Claude Code process terminated by signal SIGKILL"],
      ["'process exited' errors", "Child process exited unexpectedly"],
      ["'killed by signal' errors", "Process killed by signal SIGTERM"],
    ])("classifies %s", (_label, message) => {
      const result = classifyError(new Error(message));
      expect(result.category).toBe("process_exit");
    });

    it("preserves original error message", () => {
      const msg = "Claude Code process exited with code 1";
      const result = classifyError(new Error(msg));
      expect(result.message).toBe(msg);
    });
  });

  // ── Internal (fallback) ────────────────────────────────────────────────

  describe("internal", () => {
    it("classifies unknown errors as internal", () => {
      const result = classifyError(new Error("Something went wrong"));
      expect(result.category).toBe("internal");
    });

    it.each([
      ["non-Error inputs", "string error", "string error"],
      ["undefined input", undefined, "undefined"],
      ["null input", null, "null"],
    ])("handles %s", (_label, input, expectedMessage) => {
      const result = classifyError(input);
      expect(result.category).toBe("internal");
      expect(result.message).toBe(expectedMessage);
    });
  });

  // ── Plain objects with .message (Codex SDK event types) ───────────────

  describe("plain objects with .message", () => {
    it.each([
      ["auth message", { message: "HTTP 401 Unauthorized" }, "auth", "HTTP 401 Unauthorized"],
      ["rate_limit message", { message: "429 Too Many Requests" }, "rate_limit", undefined],
      [
        "extra properties",
        { type: "error", message: "connect ECONNREFUSED" },
        "network",
        "connect ECONNREFUSED",
      ],
      [
        "generic message as internal",
        { message: "Something went wrong" },
        "internal",
        "Something went wrong",
      ],
    ])("classifies plain object with %s", (_label, input, expectedCategory, expectedMessage?) => {
      const result = classifyError(input);
      expect(result.category).toBe(expectedCategory);
      if (expectedMessage !== undefined) {
        expect(result.message).toBe(expectedMessage);
      }
    });

    it("falls back to String() for objects without .message", () => {
      const result = classifyError({ code: 500 });
      expect(result.category).toBe("internal");
      expect(result.message).toBe("[object Object]");
    });
  });

  // ── Priority ───────────────────────────────────────────────────────────

  describe("priority", () => {
    it("abort wins over other keywords", () => {
      // AbortError name takes priority even if message mentions network
      const err = new DOMException("Network request aborted", "AbortError");
      expect(classifyError(err).category).toBe("abort");
    });

    it("auth wins over process_exit when both keywords present", () => {
      const err = new Error("HTTP 401 Unauthorized — process exited with code 1");
      expect(classifyError(err).category).toBe("auth");
    });

    it("network wins over process_exit when both keywords present", () => {
      const err = new Error("connect ECONNREFUSED — process exited with code 1");
      expect(classifyError(err).category).toBe("network");
    });

    it("preserves original error message", () => {
      const originalMsg = "HTTP 429 Too Many Requests - Retry after 10";
      const result = classifyError(new Error(originalMsg));
      expect(result.message).toBe(originalMsg);
    });
  });
});

describe("classifyStopReason", () => {
  it.each([
    ["undefined", undefined],
    ["end_turn (normal completion)", "end_turn"],
    ["stop_sequence (normal completion)", "stop_sequence"],
    ["unknown stop_reason", "some_future_reason"],
  ])("returns null for %s", (_label, reason) => {
    expect(classifyStopReason(reason)).toBeNull();
  });

  it("returns context_limit for max_tokens", () => {
    const result = classifyStopReason("max_tokens");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("context_limit");
    expect(result!.message).toContain("output token limit");
  });
});
