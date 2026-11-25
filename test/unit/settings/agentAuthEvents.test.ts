import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { AgentAuthAnswer, HarnessAuth } from "@shared/agent-auth";
import { localSignIn, readLocalAgent } from "@/features/settings/lib/local-agent-login";
import { useAgentAuthEvents } from "@/features/settings/api/settings.queries";
import { queryKeys } from "@/shared/api/queryKeys";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useStream } from "@/shared/hooks/useStream";

vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: vi.fn() }));
vi.mock("@/shared/hooks/useStream", () => ({ useStream: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const models = [...queryKeys.settings.agentModels, "workspace"];
function observe(direct = false) {
  vi.mocked(isCloudDirectWebMode).mockReturnValue(direct);
  vi.mocked(useStream).mockClear();
  const client = new QueryClient();
  client.setQueryData(models, { lists: [] });
  function Shell() {
    useAgentAuthEvents();
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Shell)));
  return client;
}

it("does not follow either computer stream in the hosted direct lane", () => {
  observe(true);
  expect(vi.mocked(useStream).mock.calls.map(([stream, filter]) => [stream.name, filter])).toEqual([
    [api.agentCliProgress.name, null],
    [api.agentAuthChanges.name, null],
  ]);
});

it.each([api.agentCliProgress, api.agentAuthChanges])(
  "reads login and workspace models again after a missed $name event",
  async (stream) => {
    const client = observe();
    client.setQueryData(queryKeys.settings.agentAuth, { clis: [] });
    const subscription = vi.mocked(useStream).mock.calls.find(([s]) => s === stream)!;
    expect(subscription[1]).toEqual({});
    subscription[3]!();
    await vi.waitFor(() => {
      expect(client.getQueryState(queryKeys.settings.agentAuth)?.isInvalidated).toBe(true);
      expect(client.getQueryState(models)?.isInvalidated).toBe(true);
    });
  }
);

it("reads workspace models again when installation or sign-in finishes", async () => {
  const client = observe();
  const [cli, auth] = vi.mocked(useStream).mock.calls;
  cli![2]({ harness: "gemini", phase: "ready", version: "1", receivedBytes: 0 });
  await vi.waitFor(() => expect(client.getQueryState(models)?.isInvalidated).toBe(true));
  client.setQueryData(models, { lists: [] });
  auth![2]({ harness: "gemini" });
  await vi.waitFor(() => expect(client.getQueryState(models)?.isInvalidated).toBe(true));
});

it("toasts the engine's reason when the first install progress is a failure", () => {
  const client = observe();
  const key = queryKeys.settings.agentAuth;
  client.setQueryData<AgentAuthAnswer>(key, {
    clis: [{ harness: "gemini", state: "missing" }],
    auth: [],
    logins: [],
  });
  const error = "The engine refused the install";
  const [cli] = vi.mocked(useStream).mock.calls;
  cli![2]({ harness: "gemini", phase: "failed", version: "", receivedBytes: 0, error });
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(error);
  expect(client.getQueryData<AgentAuthAnswer>(key)?.clis[0]).toMatchObject({
    state: "failed",
    error,
  });
});

it("discards a cold model read when sign-in finishes, including in a workspace whose picker closed", async () => {
  const client = observe();
  const open = [...queryKeys.settings.agentModels, "open"];
  const closed = [...queryKeys.settings.agentModels, "closed"];
  const signedOut = { lists: [{ harness: "gemini", models: [], error: "Sign in." }] };
  const signedIn = { lists: [{ harness: "gemini", models: [{ id: "gemini-4-neon" }] }] };
  const first = Promise.withResolvers<typeof signedOut>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(signedIn);
  const unsubscribe = new QueryObserver(client, { queryKey: open, queryFn: read }).subscribe(
    () => {}
  );
  const close = new QueryObserver(client, {
    queryKey: closed,
    queryFn: () => first.promise,
  }).subscribe(() => {});
  close();
  try {
    expect(read).toHaveBeenCalledOnce();
    expect(client.getQueryState(closed)?.fetchStatus).toBe("fetching");
    const auth = vi
      .mocked(useStream)
      .mock.calls.find(([stream]) => stream === api.agentAuthChanges)!;
    auth[2]({ harness: "gemini" });
    first.resolve(signedOut);
    await vi.waitFor(() => expect(client.getQueryData(open)).toEqual(signedIn));
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(closed)).toMatchObject({ data: undefined, isInvalidated: true });
  } finally {
    unsubscribe();
    client.clear();
  }
});

it("replaces the first login read when an install finishes before it answers", async () => {
  const client = observe();
  const key = queryKeys.settings.agentAuth;
  const installing: AgentAuthAnswer = {
    clis: [{ harness: "gemini", state: "installing" }],
    auth: [{ harness: "gemini", state: "unknown", methods: [] }],
    logins: [],
  };
  const ready: AgentAuthAnswer = {
    clis: [{ harness: "gemini", state: "ready" }],
    auth: [{ harness: "gemini", state: "signed_out", methods: [] }],
    logins: [],
  };
  const first = Promise.withResolvers<AgentAuthAnswer>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ready);
  const close = new QueryObserver(client, { queryKey: key, queryFn: read }).subscribe(() => {});
  try {
    expect(read).toHaveBeenCalledOnce();
    expect(client.getQueryData(key)).toBeUndefined();
    const [cli] = vi.mocked(useStream).mock.calls;
    cli![2]({ harness: "gemini", phase: "ready", version: "1.5.14", receivedBytes: 100 });
    first.resolve(installing);
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual(ready));
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    close();
    client.clear();
  }
});

it("checks the newly installed agent's login when Settings reopens and then offers Sign in", async () => {
  const client = observe();
  const key = queryKeys.settings.agentAuth;
  const claude: HarnessAuth = { harness: "claude-code", state: "signed_in", methods: [] };
  const before: AgentAuthAnswer = {
    clis: [
      { harness: "claude-code", state: "ready" },
      { harness: "gemini", state: "missing", version: "1.5.14" },
    ],
    auth: [
      claude,
      { harness: "gemini", state: "unknown", methods: [], error: "The CLI is not installed yet." },
    ],
    logins: [],
  };
  client.setQueryData(key, before);
  const after = Promise.withResolvers<AgentAuthAnswer>();
  const read = vi.fn(() => after.promise);
  const settings = new QueryObserver(client, { queryKey: key, queryFn: read, staleTime: 60_000 });
  const closeSettings = settings.subscribe(() => {});
  closeSettings();
  const [cli] = vi.mocked(useStream).mock.calls;
  cli![2]({ harness: "gemini", phase: "ready", version: "1.5.14", receivedBytes: 100 });
  expect(read).not.toHaveBeenCalled();

  const close = settings.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(readLocalAgent(settings.getCurrentResult(), "gemini").status).toBe("checking");
    expect(readLocalAgent(settings.getCurrentResult(), "claude-code").status).toBe("signed-in");
    const auth: HarnessAuth = {
      harness: "gemini",
      state: "signed_out",
      methods: [
        { id: "google", kind: "browser", credential: "subscription", label: "Google account" },
      ],
    };
    after.resolve({
      ...before,
      clis: [
        { harness: "claude-code", state: "ready" },
        { harness: "gemini", state: "ready" },
      ],
      auth: [claude, auth],
    });
    await vi.waitFor(() =>
      expect(localSignIn(readLocalAgent(settings.getCurrentResult(), "gemini"))).toEqual({
        kind: "start",
        auth,
      })
    );
  } finally {
    close();
    client.clear();
  }
});
