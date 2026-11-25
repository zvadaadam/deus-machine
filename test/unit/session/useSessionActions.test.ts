import { QueryClient, type MutationObserverOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionActions } from "@/features/session/hooks/useSessionActions";
import {
  emptyComposer,
  sessionComposerActions,
} from "@/features/session/store/sessionComposerStore";
import { registerDirectSession } from "@/features/session/cloud/directSessionRegistry";
import { queryKeys } from "@/shared/api/queryKeys";
import { api } from "@shared/api";
import type { PaginatedMessages, Session } from "@shared/types/session";
import { OpError, RuntimeError } from "@/platform/ws/runtime-client";
import { emitSendAttemptFailed } from "@/features/connection";

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
vi.mock("@/platform/ws", () => ({
  call: state.call,
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
      workspace_kind: "worktree",
      provider_session_id: null,
      status: "idle",
    }));
  }

  it.each(["working", "needs_response", "idle"] as const)(
    "keeps a queued send out of the transcript when the window showed %s",
    async (status) => {
      const client = state.queryClient!;
      client.setQueryData<Session>(queryKeys.sessions.detail(SESSION), (old) => ({
        ...old!,
        status,
      }));
      const key = queryKeys.sessions.messages(SESSION);
      const page: PaginatedMessages = {
        messages: [
          { id: "reply", session_id: SESSION, turn_id: "running", role: "assistant", seq: 1 },
        ],
        turns: [],
        compactions: [],
        has_older: false,
        has_newer: false,
      };
      client.setQueryData(key, page);
      state.call.mockImplementationOnce((_op, { turnId }) => {
        const ids = client
          .getQueryData<PaginatedMessages>(key)!
          .messages.map((message) => message.id);
        expect(ids).toHaveLength(status === "idle" ? 2 : 1);
        return { turnId, queued: true };
      });
      const model = "claude-code:opus";
      sessionComposerActions.seedIfAbsent(SESSION, emptyComposer(model, "high"));
      try {
        expect(
          await useSessionActions({ sessionId: SESSION, model }).sendMessage("Follow up")
        ).toBe(true);
        expect(state.call).toHaveBeenCalledExactlyOnceWith(
          api.sendMessage,
          expect.objectContaining({ content: "Follow up" })
        );
        expect(client.getQueryData(key)).toEqual(page);
        expect(state.error).not.toHaveBeenCalled();
      } finally {
        sessionComposerActions.discard(SESSION);
      }
    }
  );

  it.each(["steered", "queued", "sent"])(
    "accepts a steer answered %s without predicting a bubble",
    async (outcome) => {
      const model = "claude-code:opus";
      const content = JSON.stringify([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
      sessionComposerActions.seedIfAbsent(SESSION, emptyComposer(model, "high"));
      sessionComposerActions.togglePlanMode(SESSION);
      state.call.mockResolvedValueOnce({ outcome });
      try {
        const actions = useSessionActions({ sessionId: SESSION, model, workspaceKind: "worktree" });
        expect(await actions.sendMessage(content, "steer")).toBe(true);
        expect(state.call).toHaveBeenCalledExactlyOnceWith(api.steerMessage, {
          sessionId: SESSION,
          model: "opus",
          agentHarness: "claude-code",
          thinkingLevel: "high",
          permissionMode: "plan",
          content,
        });
        expect(
          state.queryClient!.getQueryData(queryKeys.sessions.messages(SESSION))
        ).toBeUndefined();
        expect(state.error).not.toHaveBeenCalled();
      } finally {
        sessionComposerActions.discard(SESSION);
      }
    }
  );

  it("sends with the newly picked agent even when the previous model had Plan on", async () => {
    sessionComposerActions.seedIfAbsent(SESSION, emptyComposer("claude-code:opus", "high"));
    try {
      sessionComposerActions.togglePlanMode(SESSION);
      const model = "gemini:gemini-4-neon";
      sessionComposerActions.setModel(SESSION, model, undefined, "high");
      const sent = await useSessionActions({
        sessionId: SESSION,
        model,
        workspaceKind: "worktree",
      }).sendMessage("hello");
      expect(sent).toBe(true);
      expect(state.call).toHaveBeenCalledWith(
        api.sendMessage,
        expect.objectContaining({
          sessionId: SESSION,
          agentHarness: "gemini",
          model: "gemini-4-neon",
          permissionMode: undefined,
        })
      );
    } finally {
      sessionComposerActions.discard(SESSION);
    }
  });

  it.each([
    { stage: "connect", failure: new RuntimeError("unavailable", "Host offline"), notices: 1 },
    {
      stage: "call",
      failure: new RuntimeError("unknown-outcome", "Acknowledgment lost"),
      notices: 1,
    },
    { stage: "call", failure: new OpError("Agent server is disconnected"), notices: 0 },
  ] as const)(
    "preserves newer workspace lists and reports connection trouble by kind ($failure.kind)",
    async ({ stage, failure, notices }) => {
      const { useSendMessage } = await import("@/features/session/api/session.queries");
      const client = state.queryClient!;
      const active = queryKeys.workspaces.byRepo("active");
      const archived = queryKeys.workspaces.byRepo("archived");
      const workspace = { id: "w1", current_session_id: SESSION, session_status: "idle" };
      client.setQueryData(active, [{ repo_id: "r1", workspaces: [workspace] }]);
      client.setQueryData(archived, []);
      const updated = [{ repo_id: "r1", workspaces: [workspace, { id: "another-workspace" }] }];
      state.isConnected.mockReturnValue(stage === "call");
      state[stage].mockImplementationOnce(() => {
        client.setQueryData(active, updated);
        throw failure;
      });
      await expect(
        useSendMessage().mutateAsync({
          sessionId: SESSION,
          content: "Send this once",
          turnId: "turn-once",
          agentHarness: "claude-code",
          model: "opus",
          thinkingLevel: "high",
        })
      ).rejects.toBe(failure);
      expect(client.getQueryData(active)).toEqual(updated);
      expect(client.getQueryState(active)?.isInvalidated).toBe(true);
      expect(client.getQueryState(archived)?.isInvalidated).toBe(true);
      expect(state.call).toHaveBeenCalledTimes(stage === "call" ? 1 : 0);
      expect(emitSendAttemptFailed).toHaveBeenCalledTimes(notices);
    }
  );

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
