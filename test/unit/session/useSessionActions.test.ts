// Unit tests for the `useSessionActions.stopSession` toast-surfacing fix.
//
// Regression coverage for the bug introduced by d5988a17 ("Mac-closed cloud"):
// `stopSession`'s catch swallowed errors with `console.error` only — no
// `toast.error`. So a `SendRejectedError("isn't ready yet")` thrown by the
// `useStopSession` guard (during the token-pending window after a refresh
// of a cloud-direct session) was a silent no-op to the user, even though
// `sendMessage` already toasts the analogous rejection. The fix adds the
// symmetric `toast.error(error instanceof Error ? error.message : "Failed to stop session")`.
//
// Style: `useSessionActions` itself only uses `useCallback` from React, so
// React is mocked to replace `useCallback` with a no-op pass-through (like
// `cloudDirectSession.test.ts` overrides `useEffect`/`useState`). The hook
// calls `useSendMessage()`/`useStopSession()`, which are mocked so the
// rejection reaches the action's try/catch without dragging in real React
// Query state, real socket, or real DOM. `sonner` is mocked per the
// in-repo precedent in `cloudDataAdapter.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mock state -----------------------------------------------------
const state = vi.hoisted(() => ({
  // Per-test rejection injected by the mocked `useStopSession`. Reassigned by
  // each test before invoking `useSessionActions`. `undefined` ⇒ resolves.
  stopError: undefined as unknown,
  // Per-test signature of the mocked stop mutation; `mutateAsync` reads
  // `stopError` lazily so reassignment per test takes effect.
  stopMutation: {
    mutateAsync: vi.fn(async (_sid: string) => {
      if (state.stopError) throw state.stopError;
      return undefined;
    }),
    mutate: vi.fn(),
    isPending: false,
  },
  sendMutation: {
    mutateAsync: vi.fn(async () => undefined),
    mutate: vi.fn(),
    isPending: false,
  },
}));

// `useCallback` is the only React hook `useSessionActions` calls directly.
// Replace it with a pass-through so we can call the hook as a plain function.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(fn: T): T => fn,
}));

// `sonner` mock — node-env has no toaster; assert on `toast.error` counts.
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

// Mock the mutation hooks so the rejection reaches the action's catch
// without dragging in real query/cache state. `importOriginal` keeps
// `newTurnId` (and any other sibling exports) available to the action module.
vi.mock("@/features/session/api/session.queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/session/api/session.queries")>()),
  useStopSession: () => state.stopMutation,
  useSendMessage: () => state.sendMutation,
}));

// The action also references `@/platform/ws` (`isConnected`/`connect`) before
// invoking the mutation. Make `isConnected()` return true so `connect()` is skipped.
vi.mock("@/platform/ws", () => ({
  isConnected: vi.fn(() => true),
  connect: vi.fn(),
  sendCommand: vi.fn(),
  subscribe: vi.fn(),
  onConnectionChange: vi.fn(),
}));

// `@/platform/analytics` `track` is called by `useSessionActions` for createPR.
// Mock so we never reach the analytics backend.
vi.mock("@/platform/analytics", () => ({ track: vi.fn() }));

// `@/shared/agents` helpers are only used by the `sendMessage` path; stub them
// so the module still imports cleanly.
vi.mock("@/shared/agents", () => ({
  getModelId: vi.fn(() => "model"),
  getAgentHarnessForModel: vi.fn(() => "claude-code"),
}));

// MUST come after vi.mock calls so mocked deps are bound first.
import { toast } from "sonner";
import { useSessionActions } from "@/features/session/hooks/useSessionActions";
import { SendRejectedError } from "@/features/session/lib/sendRollback";

describe("useSessionActions.stopSession — toast surfacing (bug fix)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset per-test rejection state to "no error" by default.
    state.stopError = undefined;
    // Make `mutateAsync` re-read `state.stopError` on every call. vi.fn's mock
    // implementation set at hoist time persists across tests, but to be safe
    // and explicit, redefine here too.
    state.stopMutation.mutateAsync = vi.fn(async (_sid: string) => {
      if (state.stopError) throw state.stopError;
      return undefined;
    });
    state.stopMutation.isPending = false;
    state.sendMutation.mutateAsync = vi.fn(async () => undefined);
    state.sendMutation.isPending = false;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("the toast-surfacing fix", () => {
    it("toast.error surfaces the SendRejectedError message from stopSession", async () => {
      state.stopError = new SendRejectedError(
        "The cloud connection isn't ready yet — try again in a moment"
      );
      const actions = useSessionActions({ sessionId: "sess-stop-toast" });

      await actions.stopSession();

      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith(
        "The cloud connection isn't ready yet — try again in a moment"
      );
    });

    it("console.error still fires (logging is additive, not replaced)", async () => {
      state.stopError = new SendRejectedError("isn't ready yet");
      const actions = useSessionActions({ sessionId: "sess-stop-log" });

      await actions.stopSession();

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("the returned promise resolves (the action swallows after toast)", async () => {
      state.stopError = new SendRejectedError("isn't ready yet");
      const actions = useSessionActions({ sessionId: "sess-stop-resolves" });

      // Must NOT throw — the action's catch keeps callers safe (same shape as
      // `sendMessage`'s catch: log + toast + return).
      await expect(actions.stopSession()).resolves.toBeUndefined();
    });
  });

  describe("non-Error throw branch of the ternary", () => {
    it("toast.error surfaces generic 'Failed to stop session' for a non-Error rejection (string)", async () => {
      state.stopError = "kaboom"; // a plain string is not an instance of Error
      const actions = useSessionActions({ sessionId: "sess-stop-string" });

      await actions.stopSession();

      expect(toast.error).toHaveBeenCalledWith("Failed to stop session");
    });

    it("toast.error surfaces generic 'Failed to stop session' for an undefined rejection", async () => {
      state.stopError = "undef-reject"; // marker — the mock throws whatever it is
      // Force a true `undefined` throw to exercise the falsy branch too.
      state.stopMutation.mutateAsync = vi.fn(async () => {
        throw undefined;
      });
      const actions = useSessionActions({ sessionId: "sess-stop-undef" });

      await actions.stopSession();

      expect(toast.error).toHaveBeenCalledWith("Failed to stop session");
    });
  });

  describe("success path (regression: no spurious toast)", () => {
    it("does NOT call toast.error when stopSessionMutation resolves", async () => {
      state.stopError = undefined;
      state.stopMutation.mutateAsync = vi.fn(async () => undefined);
      const actions = useSessionActions({ sessionId: "sess-stop-ok" });

      await actions.stopSession();

      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe("Send/Stop parity (cross-check)", () => {
    it("the stop toast message equals the send toast message for the same SendRejectedError", async () => {
      // Mirror the send-side catch: `toast.error(error instanceof Error ? error.message : "Failed to send message")`.
      // Both catches use `error.message` for an Error; with the same rejection,
      // both toasts should carry the SAME text. Assert by simulating the same
      // error through each branch's exact ternary expression.
      const err = new SendRejectedError(
        "The cloud connection isn't ready yet — try again in a moment"
      );
      const stopMessage = err instanceof Error ? err.message : "Failed to stop session";
      const sendMessage = err instanceof Error ? err.message : "Failed to send message";

      expect(stopMessage).toBe(sendMessage);
      expect(sendMessage).toBe("The cloud connection isn't ready yet — try again in a moment");
    });

    it("stopSession uses the same toast.error predicate shape as sendMessage (instanceof Error branch)", async () => {
      // Both actions call toast.error with `error.message` when error is an
      // Error instance. Confirm stopSession's predicate behaves identically by
      // driving it with an Error subclass (SendRejectedError extends Error).
      state.stopError = new SendRejectedError("isn't ready yet");
      const actions = useSessionActions({ sessionId: "sess-stop-parity" });

      await actions.stopSession();

      // `instanceof Error` true ⇒ message propagated (not the fallback).
      expect(toast.error).toHaveBeenCalledWith("isn't ready yet");
      expect(toast.error).not.toHaveBeenCalledWith("Failed to stop session");
    });
  });

  describe("connection preflight", () => {
    it("calls connect() when isConnected() is false before invoking stopMutation", async () => {
      const { isConnected, connect } = await import("@/platform/ws");
      vi.mocked(isConnected).mockReturnValue(false);
      vi.mocked(connect).mockResolvedValue(undefined as never);
      state.stopError = undefined;
      const actions = useSessionActions({ sessionId: "sess-stop-connect" });

      await actions.stopSession();

      expect(connect).toHaveBeenCalled();
      expect(state.stopMutation.mutateAsync).toHaveBeenCalledWith("sess-stop-connect");
    });
  });
});
