// Regression coverage for the SEND-side guard that the stop-side fix mirrors.
//
// The `useStopSession` bug fix added the symmetric `isDirectSessionCached` guard
// that `useSendMessage` already had. This file pins down the SEND-side contract
// so parity can't drift silently: if this test fails, the stop-side fix's
// mirrored guard would need to be re-evaluated too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { SendRejectedError } from "@/features/session/lib/sendRollback";

// --- Mock state shared with hoisted vi.mock factories -----------------------
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
  sendCommandMock: vi.fn(),
}));

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

// `useSendMessage` calls `sendCommand`/`connect`/`isConnected` from `@/platform/ws`.
// Mock so the guard window reaches the throw BEFORE any sendCommand dispatch.
vi.mock("@/platform/ws", () => ({
  sendCommand: state.sendCommandMock,
  connect: vi.fn(async () => undefined),
  isConnected: vi.fn(() => true),
  subscribe: vi.fn(),
  onConnectionChange: vi.fn(),
}));
vi.mock("@/features/session/api/session.service", () => ({
  SessionService: {
    stop: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    fetchById: vi.fn(async () => undefined),
    fetchByWorkspace: vi.fn(async () => []),
  },
}));
vi.mock("@/features/connection", () => ({ emitSendAttemptFailed: vi.fn() }));
vi.mock("@/platform/analytics", () => ({ track: vi.fn() }));

import { useSendMessage } from "@/features/session/api/session.queries";
import { queryKeys } from "@/shared/api/queryKeys";
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

describe("useSendMessage — guard that useStopSession mirrors (parity regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    vi.stubGlobal("localStorage", makeStorage());
    localStorage.setItem("deus.cloudDirect", "1");
  });

  afterEach(() => {
    state.queryClient?.clear();
    vi.unstubAllGlobals();
  });

  it("rejects with SendRejectedError when direct channel is unregistered but session is cached-as-direct", async () => {
    const sid = "sess-send-pending";
    state.queryClient!.setQueryData<Session>(
      queryKeys.sessions.detail(sid),
      makeSession({ id: sid, workspace_kind: "cloud", provider_session_id: `prov-${sid}` })
    );

    const m = useSendMessage();
    await expect(
      m.mutateAsync({
        sessionId: sid,
        content: "hello",
        model: "claude-opus-4-8",
        agentHarness: "claude-code",
        turnId: "turn-1",
      })
    ).rejects.toBeInstanceOf(SendRejectedError);
  });

  it("does NOT call sendCommand in the guard window", async () => {
    const sid = "sess-send-pending-no-sendcommand";
    state.queryClient!.setQueryData<Session>(
      queryKeys.sessions.detail(sid),
      makeSession({ id: sid, workspace_kind: "cloud", provider_session_id: `prov-${sid}` })
    );

    const m = useSendMessage();
    await expect(
      m.mutateAsync({
        sessionId: sid,
        content: "hello",
        model: "claude-opus-4-8",
        agentHarness: "claude-code",
        turnId: "turn-2",
      })
    ).rejects.toBeInstanceOf(SendRejectedError);
    expect(state.sendCommandMock).not.toHaveBeenCalled();
  });

  it("uses the SAME message string as the useStopSession guard (parity invariant)", async () => {
    const sid = "sess-send-parity";
    state.queryClient!.setQueryData<Session>(
      queryKeys.sessions.detail(sid),
      makeSession({ id: sid, workspace_kind: "cloud", provider_session_id: `prov-${sid}` })
    );

    const m = useSendMessage();
    await expect(
      m.mutateAsync({
        sessionId: sid,
        content: "hello",
        model: "claude-opus-4-8",
        agentHarness: "claude-code",
        turnId: "turn-3",
      })
    ).rejects.toThrow("The cloud connection isn't ready yet — try again in a moment");
  });
});
