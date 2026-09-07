// The fix's regression guard. `useStopSession.onSuccess` used to call
// `queryClient.invalidateQueries({ queryKey: sessions.detail(sessionId) })`
// unconditionally, so stopping a direct/cloud session refetched through the
// discovery adapter and clobbered the fold's live `sessions.detail` row
// (context gauge → 0%, message_count → placeholder). The fix gates that
// invalidation to the Mac lane via the SAME `getDirectSession` signal
// `mutationFn` uses to route the cancel.
//
// This suite drives the REAL `useStopSession` hook: it captures the
// `useMutation` config the hook registers (no hook-rendering harness exists
// in the test tree) and invokes the real `onSuccess` against a real
// `QueryClient`, the real `cloudDataRequestInterceptor` (so the refetch path
// under test is the production one), and the real `directSessionRegistry`
// (so the lane signal is the production one). The Mac-lane test pins the
// existing refetch behavior so the gate doesn't accidentally suppress it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import {
  registerDirectSession,
  getDirectSession,
  type DirectSessionChannel,
} from "@/features/session/cloud/directSessionRegistry";
import {
  cloudDataRequestInterceptor,
  bustCloudSessionsListCache,
} from "@/features/session/cloud/cloudDataAdapter";
import { sessionDetailQueryOptions } from "@/features/session/cloud/useIsDirectSession";
import { setQueryRequestInterceptor } from "@/platform/ws";
import type { Session } from "@/features/session/types";

// --- Mocks: keep the lane-signal + interceptor + cache REAL, stand in only for
// modules whose import would pull a DOM/PostHog/UI chain into the node env, or
// whose hook-form we don't render here. ---

// `track` and `emitSendAttemptFailed` are referenced directly in the mock
// factories, so they must be hoisted to exist at factory-eval time.
const { trackMock, emitSendAttemptFailedMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  emitSendAttemptFailedMock: vi.fn(),
}));

// `testQueryClient` and `capturedMutation` are referenced only inside nested
// functions (called later, from beforeEach/tests), so a module-level `let`
// suffices — same pattern as `let queryClient` in cloudDirectSession.test.ts.
let testQueryClient: QueryClient;
let capturedMutation:
  | {
      onSuccess?: (data: unknown, variables: string) => void;
      mutationFn?: (sessionId: string) => unknown;
    }
  | undefined;

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => testQueryClient,
    useMutation: (config) => {
      capturedMutation = config;
      return { mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn() } as never;
    },
  };
});

vi.mock("@/platform/analytics", () => ({ track: trackMock }));
vi.mock("@/shared/hooks/useQuerySubscription", () => ({ useQuerySubscription: () => {} }));
vi.mock("@/features/connection", () => ({ emitSendAttemptFailed: emitSendAttemptFailedMock }));
vi.mock("@/features/session/cloud/webCloudDirectConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/session/cloud/webCloudDirectConfig")>()),
  handleWebCloudSessionExpired: vi.fn(),
}));

import { useStopSession } from "@/features/session/api/session.queries";

const SESSION_ID = "sess-stop-lane-gate";
const detailKey = queryKeys.sessions.detail(SESSION_ID);

const fullRow = (overrides: Partial<Session> = {}): Session => ({
  id: SESSION_ID,
  workspace_id: "ws_1",
  agent_harness: "claude-code",
  provider_session_id: SESSION_ID,
  workspace_kind: "cloud",
  title: "Plan review",
  status: "working",
  message_count: 5,
  context_token_count: 50_000,
  context_used_percent: 25,
  is_hidden: false,
  last_user_message_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  ...overrides,
});

const agntSession = {
  id: SESSION_ID,
  status: "ready",
  workspace_id: "ws_1",
  workspace_status: "running",
  sandbox_id: "sb_1",
  title: "Plan review",
  repo: "acme/app",
  branch: "main",
  harness: "claude-code",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function stubDiscoveryFetch() {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/dashboard/orgs") return ok({ items: [{ id: "org_1" }] });
    if (path === "/dashboard/orgs/org_1/sessions") return ok({ items: [agntSession] });
    throw new Error(`unexpected fetch ${path}`);
  });
}

function stubBearer() {
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => (k === "deus_cloud_session" ? "the.bearer.jwt" : null),
    setItem: () => {},
    removeItem: () => {},
  } as unknown as Storage);
}

function makeChannel(): DirectSessionChannel {
  return { sendMessage: vi.fn(), cancel: vi.fn(), sendRaw: vi.fn() };
}

let obs: QueryObserver<Session> | undefined;
let invalidateSpy: ReturnType<typeof vi.spyOn>;

describe("useStopSession.onSuccess — Mac-lane invalidation gate (fix)", () => {
  beforeEach(() => {
    stubBearer();
    stubDiscoveryFetch();
    bustCloudSessionsListCache();
    setQueryRequestInterceptor(cloudDataRequestInterceptor);

    testQueryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false } },
    });
    invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries");
    trackMock.mockReset();
    emitSendAttemptFailedMock.mockReset();

    // Mount an observer on sessions.detail so invalidation actually refetches
    // — the production scenario: the panel (and its useSession) is mounted when
    // Stop fires. The queryFn is the real sessionDetailQueryOptions one, which
    // routes through the registered interceptor → toSession.
    obs = new QueryObserver<Session>(testQueryClient, sessionDetailQueryOptions(SESSION_ID));
    obs.subscribe(() => {});

    // Instantiate the hook to capture the real useMutation config. This calls
    // the mocked useQueryClient (→ testQueryClient) and useMutation (captures).
    useStopSession();
  });

  afterEach(() => {
    obs?.destroy();
    obs = undefined;
    setQueryRequestInterceptor(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    bustCloudSessionsListCache();
    // Belt-and-braces: clear any channel a failed test leaked for this session.
    // The registry has no public clear-by-id, so overwrite + dispose.
    const dummy = makeChannel();
    const dispose = registerDirectSession(SESSION_ID, dummy);
    dispose();
  });

  it("direct lane: does NOT invalidate sessions.detail — the fold's live projection survives Stop", async () => {
    // Let the observer's initial fetch (toSession placeholder) settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(testQueryClient.getQueryData<Session>(detailKey)).toMatchObject({
      status: "idle",
      message_count: 1,
      context_token_count: 0,
      context_used_percent: 0,
    });

    // The fold projects the live turn's authoritative row.
    const live = fullRow({
      status: "working",
      message_count: 5,
      context_token_count: 50_000,
      context_used_percent: 25,
    });
    testQueryClient.setQueryData<Session>(detailKey, live);
    expect(testQueryClient.getQueryData<Session>(detailKey)).toMatchObject({
      status: "working",
      message_count: 5,
      context_token_count: 50_000,
      context_used_percent: 25,
    });

    // Register the direct channel — what mutationFn just used to cancel.
    const ch = makeChannel();
    const dispose = registerDirectSession(SESSION_ID, ch);
    expect(getDirectSession(SESSION_ID)).toBe(ch);

    // === useStopSession.onSuccess fires ===
    capturedMutation!.onSuccess!(undefined, SESSION_ID);
    // Allow any in-flight refetch to settle (there must be none).
    await new Promise((r) => setTimeout(r, 30));

    // The fold's row is intact — the gate held the Mac-lane refetch back.
    expect(testQueryClient.getQueryData<Session>(detailKey)).toMatchObject({
      status: "working",
      message_count: 5,
      context_token_count: 50_000,
      context_used_percent: 25,
    });

    // sessions.detail was NOT invalidated for a direct session.
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: detailKey })
    );

    // The sidebar's workspaces list is still invalidated (both lanes).
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.workspaces.all })
    );

    // Analytics still fires with the row's agent_harness.
    expect(trackMock).toHaveBeenCalledWith("session_stopped", {
      session_id: SESSION_ID,
      agent_harness: "claude-code",
    });

    dispose();
  });

  it("Mac lane (no direct channel): invalidates sessions.detail — existing behavior preserved", async () => {
    await new Promise((r) => setTimeout(r, 30));
    expect(testQueryClient.getQueryData<Session>(detailKey)).toMatchObject({
      status: "idle",
      message_count: 1,
      context_token_count: 0,
    });

    // The fold projected a live turn; then the user stops via the Mac lane.
    const live = fullRow({
      status: "working",
      message_count: 7,
      context_token_count: 70_000,
      context_used_percent: 35,
    });
    testQueryClient.setQueryData<Session>(detailKey, live);

    // No direct channel registered → Mac lane owns this session.
    expect(getDirectSession(SESSION_ID)).toBeUndefined();

    // === useStopSession.onSuccess fires ===
    capturedMutation!.onSuccess!(undefined, SESSION_ID);
    await new Promise((r) => setTimeout(r, 30));

    // The Mac-lane invalidation refetched through the adapter, overwriting the
    // fold's row with the placeholder — the EXISTING (correct-for-Mac)
    // behavior; the Mac backend is authoritative there. This pins it so the
    // gate doesn't accidentally suppress the Mac path.
    expect(testQueryClient.getQueryData<Session>(detailKey)).toMatchObject({
      status: "idle",
      message_count: 1,
      context_token_count: 0,
      context_used_percent: 0,
    });

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: detailKey }));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.workspaces.all })
    );
    expect(trackMock).toHaveBeenCalledWith("session_stopped", {
      session_id: SESSION_ID,
      agent_harness: "claude-code",
    });
  });

  it("direct.cancel() does NOT unregister the channel — onSuccess's lane signal is stable across the mutation", () => {
    // The load-bearing assumption behind using getDirectSession at onSuccess
    // time: cancel is fire-and-forget over the socket; only the unmount
    // disposer unregisters (directSessionRegistry.ts:64-66). So onSuccess sees
    // the same lane mutationFn just routed through — the gate is unambiguous.
    const ch = makeChannel();
    const dispose = registerDirectSession(SESSION_ID, ch);
    expect(getDirectSession(SESSION_ID)).toBe(ch);

    ch.cancel("turn-1");
    expect(getDirectSession(SESSION_ID)).toBe(ch); // still registered

    dispose();
    expect(getDirectSession(SESSION_ID)).toBeUndefined();
  });
});
