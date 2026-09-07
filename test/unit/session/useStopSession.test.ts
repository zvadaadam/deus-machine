// Unit tests for the `useStopSession` hook's Mac-CLOSED direct lane.
//
// Regression coverage for the bug introduced by d5988a17 ("Mac-closed cloud"):
// after refresh of a running cloud-direct session while the token mint is still
// pending, the direct channel is unregistered but the session row IS in the
// React Query cache as a direct row. `useStopSession` previously fell through
// to `SessionService.stop`, which the web-direct transport rejects with
// "stopSession is not available without a Mac backend" — a silent no-op. The
// fix mirrors `useSendMessage`'s `isDirectSessionCached` guard: reject with
// `SendRejectedError("The cloud connection isn't ready yet — try again in a moment")`
// so `useSessionActions.stopSession` can surface it via `toast.error`.
//
// Style: like `cloudDirectSession.test.ts`, the hook is driven directly as a
// function. `useMutation` is faked so no React reconciler is required; the real
// `mutationFn` body runs (real `getDirectSession` + real `isDirectSessionCached` +
// the seeded cloud-direct state), so the guard branch under fix is exercised
// end-to-end against the same predicate the production send lane honors.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { SendRejectedError } from "@/features/session/lib/sendRollback";

// --- Mock state shared with hoisted vi.mock factories -----------------------
// All values referenced from vi.mock factories MUST be hoisted: vi.mock calls
// are hoisted above every other statement in the file, so plain `const`s
// referenced by the factory initializer would be `before initialization`.

// Structural type for the React Query `useMutation` options the real
// `useStopSession` passes — narrow enough to avoid `any` but loose enough to
// match the production hook's callsite.
type FakeMutationOptions = {
  mutationFn: (vars: unknown) => unknown | Promise<unknown>;
  onSuccess?: (data: unknown, vars: unknown, context: unknown) => void;
  onError?: (error: unknown, vars: unknown, context: unknown) => void;
};

const state = vi.hoisted(() => ({
  queryClient: undefined as QueryClient | undefined,
  lastMutation: undefined as
    | undefined
    | {
        mutateAsync: (vars: unknown) => Promise<unknown>;
        isPending: boolean;
      },
  // Fake `useMutation`: stash the options, expose `mutateAsync` that runs the
  // real `mutationFn`. `onSuccess` fires only on resolve, `onError` only on
  // reject — matching React Query's contract for branch coverage.
  useMutationImpl: vi.fn((options: FakeMutationOptions) => {
    state.lastMutation = {
      isPending: false,
      mutateAsync: async (vars: unknown) => {
        try {
          const result = await options.mutationFn(vars);
          options.onSuccess?.(result, vars, undefined);
          return result;
        } catch (error) {
          options.onError?.(error, vars, undefined);
          throw error;
        }
      },
    };
    return state.lastMutation;
  }),
  // Mock of `SessionService.stop` (the Mac-lane fallthrough). Tracked; no
  // network. Other SessionService methods are stubbed so any incidental
  // import in `session.queries.ts` does not reach the WS transport.
  stopMock: vi.fn(async (_sessionId: string) => undefined),
}));

// Minimal Map-backed Web Storage stand-ins (the suite runs node-env, no DOM).
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => state.queryClient,
  useMutation: state.useMutationImpl,
}));

// Mock the WS-backed session service: the Mac-lane fallthrough calls
// `SessionService.stop(sessionId)`. Track its calls; never hit the network.
vi.mock("@/features/session/api/session.service", () => ({
  SessionService: {
    stop: state.stopMock,
    sendMessage: vi.fn(async () => undefined),
    fetchById: vi.fn(async () => undefined),
    fetchByWorkspace: vi.fn(async () => []),
  },
}));

// Avoid import-time DOM/WS side effects from platform-ws and the connection
// emit-fanout. These modules are imported by `session.queries.ts` at load time
// but the functions we exercise never reach them on the path under test.
vi.mock("@/platform/ws", () => ({
  sendCommand: vi.fn(),
  connect: vi.fn(),
  isConnected: vi.fn(() => true),
  subscribe: vi.fn(),
  onConnectionChange: vi.fn(),
}));
vi.mock("@/features/connection", () => ({ emitSendAttemptFailed: vi.fn() }));
vi.mock("@/platform/analytics", () => ({ track: vi.fn() }));

// Must come AFTER all vi.mock calls so the mocked deps are bound before the
// module's top-level imports evaluate.
import { useStopSession } from "@/features/session/api/session.queries";
import { queryKeys } from "@/shared/api/queryKeys";
import {
  registerDirectSession,
  getDirectSession,
  type DirectSessionChannel,
} from "@/features/session/cloud/directSessionRegistry";
import type { Session } from "@/features/session/types";

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess",
    workspace_id: "ws",
    agent_harness: "claude-code",
    status: "working",
    message_count: 0,
    context_token_count: 0,
    context_used_percent: 0,
    is_hidden: false,
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  } as Session;
}

/** A unique cloud-direct row (workspace_kind "cloud" with a provider_session_id). */
function cloudDirectSession(sid: string, providerSessionId = `prov-${sid}`): Session {
  return makeSession({
    id: sid,
    workspace_id: `ws-${sid}`,
    workspace_kind: "cloud",
    provider_session_id: providerSessionId,
    status: "working",
  });
}

function makeChannel(): DirectSessionChannel {
  return { sendMessage: vi.fn(), cancel: vi.fn(), sendRaw: vi.fn() };
}

function seedDirectRow(session: Session) {
  state.queryClient!.setQueryData<Session>(queryKeys.sessions.detail(session.id), session);
}

describe("useStopSession", () => {
  let disposers: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    disposers = [];
    state.queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    // Flip the cloud-direct flag on (localStorage dev override): the real
    // `isCloudDirectEnabled()` then returns true, exercising the real
    // `isDirectSessionCached` predicate against the seeded session row.
    vi.stubGlobal("localStorage", makeStorage());
    localStorage.setItem("deus.cloudDirect", "1");
  });

  afterEach(() => {
    disposers.forEach((d) => d());
    state.queryClient?.clear();
    vi.unstubAllGlobals();
  });

  describe("the bug fix: direct session whose channel is not registered yet", () => {
    it("rejects with SendRejectedError when direct channel is unregistered but session is cached-as-direct", async () => {
      const sid = "sess-stop-pending";
      seedDirectRow(cloudDirectSession(sid));
      // No channel registered for `sid`: `getDirectSession(sid)` → undefined.
      expect(getDirectSession(sid)).toBeUndefined();

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).rejects.toBeInstanceOf(SendRejectedError);
    });

    it("rejects with the exact same message as the useSendMessage guard", async () => {
      const sid = "sess-stop-pending-msg";
      seedDirectRow(cloudDirectSession(sid));

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).rejects.toThrow(
        "The cloud connection isn't ready yet — try again in a moment"
      );
    });

    it("does NOT call SessionService.stop in the guard window", async () => {
      const sid = "sess-stop-pending-no-mac";
      seedDirectRow(cloudDirectSession(sid));

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).rejects.toBeInstanceOf(SendRejectedError);
      expect(state.stopMock).not.toHaveBeenCalled();
    });

    it("does NOT emit `emitSendAttemptFailed` for a direct-session guard throw (no Mac connection misclassification)", async () => {
      // The send-side `useSendMessage.onError` skips `emitSendAttemptFailed`
      // for a direct session; the stop-side guard must not trigger it either.
      const { emitSendAttemptFailed } = await import("@/features/connection");
      const sid = "sess-stop-pending-no-flag";
      seedDirectRow(cloudDirectSession(sid));

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).rejects.toBeInstanceOf(SendRejectedError);
      expect(emitSendAttemptFailed).not.toHaveBeenCalled();
    });

    it("does NOT emit `session_stopped` analytics on a guard throw (onSuccess does not fire on rejection)", async () => {
      // Procedure 2f: a guard-thrown rejection must not falsely credit a
      // cancelled session — the analytics event lives on `onSuccess`, which
      // React Query only invokes on resolve, never on rejection. The fake
      // `useMutation` here mirrors that contract (onSuccess is skipped on
      // throw), so `track("session_stopped", ...)` MUST NOT be called.
      const { track } = await import("@/platform/analytics");
      const sid = "sess-stop-pending-no-track";
      seedDirectRow(cloudDirectSession(sid));

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).rejects.toBeInstanceOf(SendRejectedError);
      expect(track).not.toHaveBeenCalled();
    });
  });

  describe("happy path: registered direct channel", () => {
    it("cancels via direct.cancel() and resolves", async () => {
      const sid = "sess-stop-registered";
      seedDirectRow(cloudDirectSession(sid));
      const channel = makeChannel();
      disposers.push(registerDirectSession(sid, channel));
      expect(getDirectSession(sid)).toBe(channel);

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).resolves.toBeUndefined();
      expect(channel.cancel).toHaveBeenCalledTimes(1);
    });

    it("does NOT call SessionService.stop when the channel owns the cancel", async () => {
      const sid = "sess-stop-registered-no-mac";
      seedDirectRow(cloudDirectSession(sid));
      const channel = makeChannel();
      disposers.push(registerDirectSession(sid, channel));

      const m = useStopSession();
      await m.mutateAsync(sid);
      expect(state.stopMock).not.toHaveBeenCalled();
    });

    it("fires onSuccess invalidations and session_stopped analytics on a clean direct cancel", async () => {
      const { track } = await import("@/platform/analytics");
      const sid = "sess-stop-registered-success";
      seedDirectRow(cloudDirectSession(sid));
      const channel = makeChannel();
      disposers.push(registerDirectSession(sid, channel));

      const invalidateSpy = vi.spyOn(state.queryClient!, "invalidateQueries");

      const m = useStopSession();
      await m.mutateAsync(sid);

      expect(track).toHaveBeenCalledWith(
        "session_stopped",
        expect.objectContaining({ session_id: sid })
      );
      const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(queryKeys.sessions.detail(sid));
      expect(invalidatedKeys).toContainEqual(queryKeys.workspaces.all);
    });
  });

  describe("Mac-lane fallthrough: not a direct session", () => {
    it("calls SessionService.stop when the cloud-direct flag is OFF (even for a cloud row)", async () => {
      const sid = "sess-stop-flag-off";
      // Turn the flag OFF: a backed build has no business rejecting the Mac stop.
      localStorage.removeItem("deus.cloudDirect");
      seedDirectRow(cloudDirectSession(sid));

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).resolves.toBeUndefined();
      expect(state.stopMock).toHaveBeenCalledWith(sid);
    });

    it("calls SessionService.stop for a worktree session row (workspace_kind != cloud)", async () => {
      const sid = "sess-stop-worktree";
      seedDirectRow(
        makeSession({ id: sid, workspace_kind: "worktree", provider_session_id: null })
      );

      const m = useStopSession();
      await m.mutateAsync(sid);
      expect(state.stopMock).toHaveBeenCalledWith(sid);
    });

    it("calls SessionService.stop when the row has no provider_session_id (not-yet-running cloud tab)", async () => {
      const sid = "sess-stop-no-provider";
      seedDirectRow(makeSession({ id: sid, workspace_kind: "cloud", provider_session_id: null }));

      const m = useStopSession();
      await m.mutateAsync(sid);
      expect(state.stopMock).toHaveBeenCalledWith(sid);
    });

    it("calls SessionService.stop when the row is uncached (not-direct predicate is false)", async () => {
      const sid = "sess-stop-uncached";
      // No row in the cache; a fresh renderer with no session detail yet.
      expect(state.queryClient!.getQueryData(queryKeys.sessions.detail(sid))).toBeUndefined();

      const m = useStopSession();
      await m.mutateAsync(sid);
      expect(state.stopMock).toHaveBeenCalledWith(sid);
    });

    it("does NOT throw SendRejectedError on the Mac path", async () => {
      const sid = "sess-stop-mac-no-throw";
      localStorage.removeItem("deus.cloudDirect");
      seedDirectRow(cloudDirectSession(sid));

      const m = useStopSession();
      // resolves (SessionService.stop mock resolves), does not reject.
      await expect(m.mutateAsync(sid)).resolves.toBeUndefined();
    });
  });

  describe("guard conjunction: not direct channel AND not direct row → fall through, not reject", () => {
    it("falls through to SessionService.stop when the channel is unregistered AND the row is not direct", async () => {
      // Window NOT exercised by the guard: unregistered channel but NOT a
      // direct row. The guard must NOT fire here — Guard is conjunctional.
      const sid = "sess-stop-fallthrough";
      seedDirectRow(
        makeSession({ id: sid, workspace_kind: "worktree", provider_session_id: null })
      );
      expect(getDirectSession(sid)).toBeUndefined();

      const m = useStopSession();
      await expect(m.mutateAsync(sid)).resolves.toBeUndefined();
      expect(state.stopMock).toHaveBeenCalledWith(sid);
    });
  });
});
