import { QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionActions } from "@/features/session/hooks/useSessionActions";
import { registerDirectSession } from "@/features/session/cloud/directSessionRegistry";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Session } from "@shared/types/session";

const state = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  sendCommand: vi.fn(),
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
vi.mock("@/platform/ws", () => ({
  sendCommand: state.sendCommand,
  connect: state.connect,
  isConnected: state.isConnected,
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
  state.sendCommand.mockResolvedValue({ accepted: true });
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
    expect(state.sendCommand).not.toHaveBeenCalled();
    expectUnstopped();

    const cancel = vi.fn();
    disposeChannel = registerDirectSession(SESSION, {
      sendMessage: vi.fn(),
      sendRaw: vi.fn(),
      cancel,
    });
    state.error.mockClear();
    await actions.stopSession();
    expect(cancel).toHaveBeenCalledExactlyOnceWith();
    expect(state.sendCommand).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
  });

  it.each([
    "Cloud session socket is not connected",
    "The session lost its connection — reconnecting, try again in a moment.",
  ])("shows failed direct delivery: %s", async (message) => {
    disposeChannel = registerDirectSession(SESSION, {
      sendMessage: vi.fn(),
      sendRaw: vi.fn(),
      cancel: () => {
        throw new Error(message);
      },
    });
    await useSessionActions({ sessionId: SESSION }).stopSession();
    expect(state.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(state.sendCommand).not.toHaveBeenCalled();
    expectUnstopped();
  });

  it("keeps desktop-owned cloud sessions on the desktop command path", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    state.isConnected.mockReturnValue(false);
    await useSessionActions({ sessionId: SESSION }).stopSession();
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.sendCommand).toHaveBeenCalledExactlyOnceWith("stopSession", {
      sessionId: SESSION,
    });
    expect(state.error).not.toHaveBeenCalled();
  });

  it("surfaces desktop rejection without reporting a successful stop", async () => {
    state.queryClient!.setQueryData<Session>(queryKeys.sessions.detail(SESSION), (session) => ({
      ...session!,
      workspace_kind: "worktree",
      provider_session_id: null,
    }));
    state.sendCommand.mockResolvedValue({ accepted: false, error: "Stop could not be delivered" });
    await useSessionActions({ sessionId: SESSION }).stopSession();
    expect(state.error).toHaveBeenCalledExactlyOnceWith("Stop could not be delivered");
    expectUnstopped();
  });
});
