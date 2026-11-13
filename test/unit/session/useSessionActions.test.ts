import { QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionActions } from "@/features/session/hooks/useSessionActions";
import { registerDirectSession } from "@/features/session/cloud/directSessionRegistry";
import { queryKeys } from "@/shared/api/queryKeys";
import { api } from "@shared/api";
import type { Session } from "@shared/types/session";
import { OpError } from "@/platform/ws/runtime-client";

const state = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  call: vi.fn(),
  connect: vi.fn(),
  isConnected: vi.fn(),
  error: vi.fn(),
  track: vi.fn(),
}));

// Keep the action, mutation lifecycle, session service, lane selection and cache real.
// Replace React's mounting layer and the transport/notification boundaries.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => state.queryClient!,
    useMutation: <TData, TVariables, TContext>(
      options: MutationObserverOptions<TData, Error, TVariables, TContext>
    ) => {
      const observer = new actual.MutationObserver(state.queryClient!, options);
      return {
        mutateAsync: (variables: TVariables) => observer.mutate(variables),
        isPending: false,
      };
    },
  };
});
vi.mock("@/platform/ws", async () => ({
  call: state.call,
  connect: state.connect,
  isConnected: state.isConnected,
  OpError: (await import("@/platform/ws/runtime-client")).OpError,
}));
vi.mock("sonner", () => ({ toast: { error: state.error } }));
vi.mock("@/features/connection", () => ({ emitSendAttemptFailed: vi.fn() }));
vi.mock("@/platform/analytics", () => ({ track: state.track }));

const SESSION = "stop-session";
let disposeChannel: (() => void) | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VITE_CLOUD_DIRECT", "0");
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "deus.cloudDirect" ? "1" : null),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.isConnected.mockReturnValue(true);
  state.call.mockResolvedValue({ unconfirmed: false });
  state.queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  state.queryClient.setQueryData<Session>(queryKeys.sessions.detail(SESSION), {
    id: SESSION,
    workspace_id: "workspace",
    workspace_kind: "cloud",
    provider_session_id: "provider-session",
    agent_harness: "claude-code",
    status: "working",
    message_count: 2,
    context_token_count: 0,
    context_used_percent: 0,
    is_hidden: false,
    updated_at: "2026-09-07T12:00:00Z",
  });
});

afterEach(() => {
  disposeChannel?.();
  disposeChannel = undefined;
  state.queryClient!.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function expectUnstopped() {
  expect(state.queryClient!.getQueryData<Session>(queryKeys.sessions.detail(SESSION))?.status).toBe(
    "working"
  );
  expect(state.track).not.toHaveBeenCalled();
}

describe("Stop delivery", () => {
  it("tells the user to retry while the direct channel is absent, then cancels once connected", async () => {
    const actions = useSessionActions({ sessionId: SESSION });
    await actions.stopSession();
    expect(state.error).toHaveBeenCalledExactlyOnceWith(
      "The cloud connection isn't ready yet — try again in a moment"
    );
    expect(state.call).not.toHaveBeenCalled();
    expectUnstopped();

    const cancel = vi.fn();
    disposeChannel = registerDirectSession(
      SESSION,
      {
        sendMessage: vi.fn(),
        sendRaw: vi.fn(),
        cancel,
      },
      state.queryClient!
    );
    state.error.mockClear();
    await actions.stopSession();
    expect(cancel).toHaveBeenCalledExactlyOnceWith();
    expect(state.call).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
  });

  it.each([
    "Cloud session socket is not connected",
    "The session lost its connection — reconnecting, try again in a moment.",
  ])("shows failed direct delivery: %s", async (message) => {
    disposeChannel = registerDirectSession(
      SESSION,
      {
        sendMessage: vi.fn(),
        sendRaw: vi.fn(),
        cancel: () => {
          throw new Error(message);
        },
      },
      state.queryClient!
    );
    await useSessionActions({ sessionId: SESSION }).stopSession();
    expect(state.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(state.call).not.toHaveBeenCalled();
    expectUnstopped();
  });

  it("keeps desktop-owned cloud sessions on the desktop command path", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    state.isConnected.mockReturnValue(false);
    await useSessionActions({ sessionId: SESSION }).stopSession();
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.call).toHaveBeenCalledExactlyOnceWith(api.stopSession, { sessionId: SESSION });
    expect(state.error).not.toHaveBeenCalled();
  });

  it("surfaces desktop rejection without reporting a successful stop", async () => {
    state.queryClient!.setQueryData<Session>(queryKeys.sessions.detail(SESSION), (session) => ({
      ...session!,
      workspace_kind: "worktree",
      provider_session_id: null,
    }));
    state.call.mockRejectedValue(new OpError("Stop could not be delivered"));
    await useSessionActions({ sessionId: SESSION }).stopSession();
    expect(state.error).toHaveBeenCalledExactlyOnceWith("Stop could not be delivered");
    expectUnstopped();
  });
});

describe("backend prompt delivery", () => {
  beforeEach(() => {
    storageForLocalSession();
  });

  function storageForLocalSession() {
    state.queryClient!.setQueryData<Session>(queryKeys.sessions.detail(SESSION), (old) => ({
      ...old!,
      workspace_kind: "local",
      provider_session_id: null,
    }));
  }

  it("does not resubmit a prompt after losing the reply", async () => {
    const { useSendMessage } = await import("@/features/session/api/session.queries");
    const { RuntimeError } = await import("@/platform/ws/runtime-client");
    const failure = new RuntimeError("unknown-outcome", "Acknowledgment lost");
    state.call.mockRejectedValue(failure);
    await expect(
      useSendMessage().mutateAsync({
        sessionId: SESSION,
        content: "Run this once",
        turnId: "turn-once",
      })
    ).rejects.toBe(failure);
    expect(state.call).toHaveBeenCalledTimes(1);
    expect(state.call.mock.calls[0][0]).toBe(api.sendMessage);
  });

  it("does not resubmit an authoritative rejection", async () => {
    const { useSendMessage } = await import("@/features/session/api/session.queries");
    state.call.mockRejectedValue(new OpError("Already running"));
    await expect(
      useSendMessage().mutateAsync({
        sessionId: SESSION,
        content: "Run this once",
        turnId: "turn-rejected",
      })
    ).rejects.toThrow("Already running");
    expect(state.call).toHaveBeenCalledTimes(1);
  });

  it("keeps a send waiting for connection on its original runtime when that runtime is disposed", async () => {
    const { useSendMessage } = await import("@/features/session/api/session.queries");
    const { RuntimeClient } = await import("@/platform/ws/runtime-client");
    const original = new RuntimeClient(
      { host: "A", account: "account", grant: "A" },
      {
        queryClient: state.queryClient!,
        open: () => new Promise(() => {}),
      }
    );
    const next = new RuntimeClient(
      { host: "B", account: "account", grant: "B" },
      {
        open: () => new Promise(() => {}),
      }
    );
    const otherSend = vi.spyOn(next, "call");
    const result = useSendMessage().mutateAsync({
      sessionId: SESSION,
      content: "Only for A",
      turnId: "turn-A",
    });
    const rejected = expect(result).rejects.toMatchObject({ kind: "disposed" });
    await vi.waitFor(() => expect(original.getState()).toBe("connecting"));
    original.dispose();
    await rejected;
    expect(state.call).not.toHaveBeenCalled();
    expect(otherSend).not.toHaveBeenCalled();
    next.dispose();
  });
});
