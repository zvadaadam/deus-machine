import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { AgentAuthAnswer, HarnessAuth } from "@shared/agent-auth";
import { agentReadiness } from "@shared/agent-readiness";
import {
  installLabel,
  installLocalAgent,
  localSignIn,
  readLocalAgent,
} from "@/features/settings/lib/local-agent-login";
import { useAgentAuth, useAgentAuthEvents } from "@/features/settings/api/settings.queries";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { queryClient, setActiveQueryClient } from "@/shared/api/queryClient";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useStream } from "@/shared/hooks/useStream";

vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: vi.fn() }));
vi.mock("@/shared/hooks/useStream", () => ({ useStream: vi.fn() }));
vi.mock("@/platform/ws", () => ({ call: vi.fn() }));

beforeEach(() => {
  vi.spyOn(toast, "error").mockClear();
});
const originalClient = queryClient;
afterEach(() => setActiveQueryClient(originalClient));

const models = [...queryKeys.settings.agentModels, "workspace"];
function observe(direct = false) {
  vi.mocked(isCloudDirectWebMode).mockReturnValue(direct);
  vi.mocked(useStream).mockClear();
  const client = new QueryClient();
  setActiveQueryClient(client);
  client.setQueryData(models, { lists: [] });
  function Shell() {
    useAgentAuthEvents();
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Shell)));
  return client;
}

function failInstall(harness: string, error: string) {
  const [cli] = vi.mocked(useStream).mock.calls;
  cli![2]({ harness, phase: "failed", version: "", receivedBytes: 0, error });
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

it.each([
  [
    "gemini",
    "The engine refused the install",
    "Couldn’t install Gemini: The engine refused the install",
  ],
  ["codex-app-server", "  ", "Couldn’t install Codex: The install failed."],
] as const)(
  "names the agent and install when this window's %s request fails",
  async (harness, error, message) => {
    observe();
    await installLocalAgent(harness);
    failInstall(harness, error);
    failInstall(harness, error);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(message, {
      id: `cli-install-${harness}`,
    });
  }
);

it.each([
  ["1.5.14", { state: "unknown", status: "install-failed" }, "Try again"],
  [undefined, { state: "not_installed" }, undefined],
] as const)(
  "uses the row's version %s for a failure this window didn't request",
  (version, readiness, action) => {
    const client = observe();
    const key = queryKeys.settings.agentAuth;
    const harness = "gemini";
    const error = "The CLI cache is unavailable";
    client.setQueryData<AgentAuthAnswer>(key, {
      clis: [{ harness, state: "missing", version }],
      auth: [],
      logins: [],
    });
    failInstall(harness, error);
    const data = client.getQueryData<AgentAuthAnswer>(key)!;
    expect(data.clis[0]).toMatchObject({ state: "failed", version, error });
    expect(agentReadiness(data, harness)).toMatchObject({
      ...readiness,
      detail: expect.stringContaining(error),
    });
    expect(installLabel(readLocalAgent({ data, isFetching: false, isError: false }, harness))).toBe(
      action
    );
    expect(toast.error).not.toHaveBeenCalled();
  }
);

it("leaves other harnesses quiet and clears this window's install when it is ready", async () => {
  observe();
  const [cli] = vi.mocked(useStream).mock.calls;
  await installLocalAgent("gemini");
  failInstall("codex-app-server", "Download failed");
  cli![2]({ harness: "gemini", phase: "ready", version: "1", receivedBytes: 0 });
  failInstall("gemini", "Download failed");
  expect(toast.error).not.toHaveBeenCalled();
});

it("keeps an install and its late refusal on the computer that received the request", async () => {
  observe();
  const first = Promise.withResolvers<void>();
  vi.mocked(call).mockReturnValueOnce(first.promise);
  const install = installLocalAgent("gemini");
  observe();
  failInstall("gemini", "Another computer's install");
  await installLocalAgent("gemini");
  first.reject(new Error("Left the first computer"));
  await install;
  expect(toast.error).not.toHaveBeenCalled();
  failInstall("gemini", "Download failed");
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn’t install Gemini: Download failed", {
    id: "cli-install-gemini",
  });
});

it.each(["ready", "failed"] as const)(
  "retires a requested install when the stream resets after a missed %s event",
  async (state) => {
    observe();
    await installLocalAgent("gemini");
    vi.mocked(call).mockResolvedValueOnce({
      auth: [],
      clis: [
        { harness: "gemini", state, error: state === "failed" ? "Download failed" : undefined },
      ],
      logins: [],
    });
    const [cli] = vi.mocked(useStream).mock.calls;
    await cli![3]!();
    failInstall("gemini", "A later install");
    if (state === "failed") {
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "Couldn’t install Gemini: Download failed",
        {
          id: "cli-install-gemini",
        }
      );
    } else expect(toast.error).not.toHaveBeenCalled();
  }
);

it.each(["ordinary read", "retry during reset", "progress during reset"])(
  "leaves the current install to report its own failure after %s",
  async (scenario) => {
    const client = observe();
    await installLocalAgent("gemini");
    const old = Promise.withResolvers<AgentAuthAnswer>();
    vi.mocked(call).mockReturnValueOnce(old.promise);
    const [cli] = vi.mocked(useStream).mock.calls;
    let read;
    if (scenario === "ordinary read") {
      function Settings() {
        useAgentAuth();
        return null;
      }
      renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Settings)));
      read = client.getQueryCache().find({ queryKey: queryKeys.settings.agentAuth })!.fetch();
    } else {
      read = cli![3]!();
    }
    if (scenario !== "progress during reset") await installLocalAgent("gemini");
    if (scenario !== "retry during reset")
      cli![2]({ harness: "gemini", phase: "downloading", version: "2", receivedBytes: 10 });
    old.resolve({
      auth: [],
      logins: [],
      clis: [{ harness: "gemini", state: "failed", error: "Old download" }],
    });
    await read;
    expect(toast.error).not.toHaveBeenCalled();
    failInstall("gemini", "Current download");
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t install Gemini: Current download",
      {
        id: "cli-install-gemini",
      }
    );
    client.clear();
  }
);

it.each(["progress", "rejection"])(
  "shows one toast for a rejected install when %s arrives first",
  async (first) => {
    observe();
    const request = Promise.withResolvers<void>();
    vi.mocked(call).mockReturnValueOnce(request.promise);
    const installing = installLocalAgent("claude-code");
    if (first === "progress") failInstall("claude-code", "Download failed");
    request.reject(new Error("Could not reach the engine"));
    await installing;
    if (first === "rejection") failInstall("claude-code", "Download failed");
    const id = "cli-install-claude-code";
    const message =
      first === "progress"
        ? "Couldn’t install Claude Code: Download failed"
        : "Could not reach the engine";
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(message, { id });
    expect(toast.getToasts().filter((item) => item.id === id)).toMatchObject([{ title: message }]);
  }
);

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
