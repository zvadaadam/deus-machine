import { describe, it, expect } from "vitest";
import { classifyError, type ClassifiedError } from "../agents/error-classifier";

describe("classifyError", () => {
  // ── Abort ──────────────────────────────────────────────────────────────

  describe("abort", () => {
    it("classifies AbortError by name", () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      const result = classifyError(err);
      expect(result.category).toBe("abort");
      expect(result.willRetry).toBe(false);
    });

    it("classifies error with 'aborted' in message", () => {
      const err = new Error("Request aborted by user");
      const result = classifyError(err);
      expect(result.category).toBe("abort");
      expect(result.willRetry).toBe(false);
    });
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  describe("auth", () => {
    it("classifies 401 errors", () => {
      const result = classifyError(new Error("HTTP 401 Unauthorized"));
      expect(result.category).toBe("auth");
      expect(result.willRetry).toBe(false);
    });

    it("classifies 403 errors", () => {
      const result = classifyError(new Error("HTTP 403 Forbidden"));
      expect(result.category).toBe("auth");
      expect(result.willRetry).toBe(false);
    });

    it("classifies invalid API key", () => {
      const result = classifyError(new Error("Invalid API key provided"));
      expect(result.category).toBe("auth");
    });

    it("classifies invalid x-api-key", () => {
      const result = classifyError(new Error("Invalid x-api-key header"));
      expect(result.category).toBe("auth");
    });

    it("classifies authentication failure", () => {
      const result = classifyError(new Error("Authentication failed"));
      expect(result.category).toBe("auth");
    });
  });

  // ── Rate Limit ─────────────────────────────────────────────────────────

  describe("rate_limit", () => {
    it("classifies 429 errors", () => {
      const result = classifyError(new Error("HTTP 429 Too Many Requests"));
      expect(result.category).toBe("rate_limit");
      expect(result.willRetry).toBe(true);
      expect(result.retryAfterMs).toBe(5000); // default
    });

    it("classifies rate limit messages", () => {
      const result = classifyError(new Error("Rate limit exceeded"));
      expect(result.category).toBe("rate_limit");
      expect(result.willRetry).toBe(true);
    });

    it("classifies overloaded errors", () => {
      const result = classifyError(new Error("Server overloaded, please try again"));
      expect(result.category).toBe("rate_limit");
      expect(result.willRetry).toBe(true);
    });

    it("extracts retry-after value", () => {
      const result = classifyError(new Error("Rate limit exceeded. Retry after 30 seconds"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryAfterMs).toBe(30000);
    });
  });

  // ── Context Limit ──────────────────────────────────────────────────────

  describe("context_limit", () => {
    it("classifies context length exceeded", () => {
      const result = classifyError(new Error("Context length exceeded"));
      expect(result.category).toBe("context_limit");
      expect(result.willRetry).toBe(false);
    });

    it("classifies context limit errors", () => {
      const result = classifyError(new Error("Context limit reached"));
      expect(result.category).toBe("context_limit");
    });
  });

  // ── Network ────────────────────────────────────────────────────────────

  describe("network", () => {
    it("classifies ECONNREFUSED", () => {
      const result = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443"));
      expect(result.category).toBe("network");
      expect(result.willRetry).toBe(true);
      expect(result.retryAfterMs).toBe(3000);
    });

    it("classifies ETIMEDOUT", () => {
      const result = classifyError(new Error("connect ETIMEDOUT"));
      expect(result.category).toBe("network");
    });

    it("classifies DNS errors", () => {
      const result = classifyError(new Error("getaddrinfo DNS resolution failed"));
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
    it("classifies database locked", () => {
      const result = classifyError(new Error("SQLITE_BUSY: database is locked"));
      expect(result.category).toBe("db_write");
      expect(result.willRetry).toBe(true);
      expect(result.retryAfterMs).toBe(500);
    });

    it("classifies readonly database", () => {
      const result = classifyError(new Error("SQLITE_READONLY: attempt to write a readonly database"));
      expect(result.category).toBe("db_write");
    });

    it("classifies 'database is busy' as db_write", () => {
      const result = classifyError(new Error("database is busy"));
      expect(result.category).toBe("db_write");
      expect(result.willRetry).toBe(true);
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
      expect(result.willRetry).toBe(false);
    });
  });

  // ── Internal (fallback) ────────────────────────────────────────────────

  describe("internal", () => {
    it("classifies unknown errors as internal", () => {
      const result = classifyError(new Error("Something went wrong"));
      expect(result.category).toBe("internal");
      expect(result.willRetry).toBe(false);
    });

    it("handles non-Error inputs", () => {
      const result = classifyError("string error");
      expect(result.category).toBe("internal");
      expect(result.message).toBe("string error");
      expect(result.willRetry).toBe(false);
    });

    it("handles undefined input", () => {
      const result = classifyError(undefined);
      expect(result.category).toBe("internal");
      expect(result.message).toBe("undefined");
    });

    it("handles null input", () => {
      const result = classifyError(null);
      expect(result.category).toBe("internal");
      expect(result.message).toBe("null");
    });
  });

  // ── Plain objects with .message (Codex SDK event types) ───────────────

  describe("plain objects with .message", () => {
    it("classifies plain object with auth message", () => {
      // Codex SDK ThreadError shape: { message: string }
      const result = classifyError({ message: "HTTP 401 Unauthorized" });
      expect(result.category).toBe("auth");
      expect(result.message).toBe("HTTP 401 Unauthorized");
      expect(result.willRetry).toBe(false);
    });

    it("classifies plain object with rate_limit message", () => {
      const result = classifyError({ message: "429 Too Many Requests" });
      expect(result.category).toBe("rate_limit");
      expect(result.willRetry).toBe(true);
    });

    it("classifies plain object with extra properties", () => {
      // Codex SDK ThreadErrorEvent shape: { type: "error", message: string }
      const result = classifyError({ type: "error", message: "connect ECONNREFUSED" });
      expect(result.category).toBe("network");
      expect(result.message).toBe("connect ECONNREFUSED");
      expect(result.willRetry).toBe(true);
    });

    it("classifies plain object with generic message as internal", () => {
      const result = classifyError({ message: "Something went wrong" });
      expect(result.category).toBe("internal");
      expect(result.message).toBe("Something went wrong");
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

    it("preserves original error message", () => {
      const originalMsg = "HTTP 429 Too Many Requests - Retry after 10";
      const result = classifyError(new Error(originalMsg));
      expect(result.message).toBe(originalMsg);
    });
  });
});
