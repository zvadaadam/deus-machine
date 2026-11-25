import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentServerClient, LoginError, type LoginHandle } from "@zvada/agent-server/client";
import { AgentRuntime, createAgentRegistry } from "@zvada/agent-server/core";
import { AgentServer } from "@zvada/agent-server/server";
import { channelPair } from "@zvada/agent-server/protocol";
import type {
  AuthUpdated,
  HarnessAuth,
  HarnessCli,
  HarnessCliProgress,
} from "@zvada/agent-server/protocol";

const mockPublish = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/streams", () => ({ publish: mockPublish }));

import { LocalAgents } from "../../../src/services/agent/local-agents";
import { agentAuthChanges, agentCliProgress } from "@shared/api/settings";
import { LOCAL_HARNESSES } from "@shared/harnesses";
import { published } from "../../helpers";

const browser = { id: "claudeai", kind: "browser", label: "Claude", credential: "subscription" };
const signedOut: HarnessAuth = { harness: "claude-code", state: "signed_out", methods: [browser] };
const signedIn: HarnessAuth = {
  ...signedOut,
  state: "signed_in",
  credential: "subscription",
  source: "login",
  label: "Claude Max",
};

const cli: HarnessCli = {
  harness: "claude-code",
  state: "ready",
  version: "0.3.288",
  source: "cache",
};

/** The engine's client as LocalAgents uses it: CLIs, status, a login handle, and its notices. */
function engine(auth: HarnessAuth) {
  let updated: (update: AuthUpdated) => void = () => {};
  let progressed: (progress: HarnessCliProgress) => void = () => {};
  let settle!: { resolve: (auth: HarnessAuth) => void; reject: (error: unknown) => void };
  const handle: LoginHandle = {
    loginId: "login-1",
    harness: "claude-code",
    method: "claudeai",
    url: "https://claude.ai/oauth",
    expiresAt: 1,
    done: new Promise<HarnessAuth>((resolve, reject) => {
      settle = { resolve, reject };
    }),
    complete: vi.fn(async () => signedIn),
    cancel: vi.fn(async () => {}),
  };
  handle.done.catch(() => {});
  const client = {
    authStatus: vi.fn(async () => [auth]),
    login: vi.fn(async () => handle),
    logout: vi.fn(async () => signedOut),
    listClis: vi.fn(async () => [cli]),
    listModels: vi.fn(async ({ harness }: { harness: string }) => ({
      harness,
      models: [],
      source: "live",
      fetchedAt: 1,
    })),
    prepareClis: vi.fn(async () => [cli]),
    onAuthUpdated: (handler: (update: AuthUpdated) => void) => {
      updated = handler;
      return () => {};
    },
    onCliProgress: (handler: (progress: HarnessCliProgress) => void) => {
      progressed = handler;
      return () => {};
    },
  };
  return {
    logins: new LocalAgents(client as unknown as AgentServerClient),
    client,
    handle,
    settle: () => settle,
    tellUpdate: (update: AuthUpdated) => updated(update),
    tellProgress: (progress: HarnessCliProgress) => progressed(progress),
  };
}

beforeEach(() => mockPublish.mockClear());

describe("LocalAgents", () => {
  it("asks each harness's CLI for its models, for the folder a turn would run in", async () => {
    const { logins, client } = engine(signedIn);
    const cwd = "/repo/.deus/berlin";
    await expect(logins.models(cwd)).resolves.toEqual(
      LOCAL_HARNESSES.map((harness) => expect.objectContaining({ harness, source: "live" }))
    );
    expect(client.listModels.mock.calls).toEqual(
      LOCAL_HARNESSES.map((harness) => [{ harness, cwd }])
    );
    client.listModels.mockClear();
    await logins.models();
    expect(client.listModels.mock.calls).toEqual(LOCAL_HARNESSES.map((harness) => [{ harness }]));
  });

  it("keeps the other agents' logins when one CLI is slow and then fails to answer", async () => {
    const registry = createAgentRegistry({ harnesses: [...LOCAL_HARNESSES] });
    vi.spyOn(registry.provisioner!, "status").mockResolvedValue({
      state: "ready",
      source: "cache",
      path: "/fixture/cli",
    });
    for (const harness of LOCAL_HARNESSES) {
      const login = registry.getAgent(harness).login!;
      vi.spyOn(login, "methods").mockResolvedValue([]);
      vi.spyOn(login, "status").mockResolvedValue({ state: "signed_out" });
    }
    const slow = Promise.withResolvers<never>();
    const status = vi.mocked(registry.getAgent("gemini").login!.status);
    status.mockReturnValue(slow.promise);
    const server = new AgentServer(new AgentRuntime(registry));
    const wire = channelPair();
    server.attach(wire.server);
    const client = await AgentServerClient.attach(wire.client);
    const agents = new LocalAgents(client);
    try {
      const answer = agents.status();
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      slow.reject(new Error("Could not read this login"));
      const { auth, clis, error } = await answer;
      expect(error).toBeUndefined();
      expect(clis.map((cli) => cli.state)).toEqual(["ready", "ready", "ready"]);
      expect(auth).toEqual([
        { harness: "claude-code", state: "signed_out", methods: [] },
        { harness: "codex-app-server", state: "signed_out", methods: [] },
        { harness: "gemini", state: "unknown", methods: [], error: "Could not read this login" },
      ]);
    } finally {
      agents.dispose();
      await client.close();
      await server.shutdown();
    }
  });

  it("reads only the named CLI when a start needs its model", async () => {
    const { logins, client } = engine(signedIn);
    const cwd = "/repo/.deus/berlin";
    const harness = "claude-code";
    await expect(logins.models(cwd, harness)).resolves.toEqual([
      expect.objectContaining({ harness }),
    ]);
    expect(client.listModels).toHaveBeenCalledExactlyOnceWith({ harness, cwd });
  });

  it("picks up a login this computer already has, and opens nothing", async () => {
    const { logins, client } = engine(signedIn);
    await expect(logins.signIn("claude-code", "claudeai")).resolves.toEqual({ already: signedIn });
    expect(client.login).not.toHaveBeenCalled();
  });

  it("runs the CLI's sign-in, shows it while under way, and takes the code from another device", async () => {
    const { logins, client, handle, settle } = engine(signedOut);
    const answer = await logins.signIn("claude-code", "claudeai");
    expect(answer).toEqual({ login: expect.objectContaining({ loginId: "login-1" }) });
    expect(client.login).toHaveBeenCalledWith("claude-code", "claudeai", {});
    expect((await logins.status()).logins).toEqual([
      expect.objectContaining({ loginId: "login-1", url: "https://claude.ai/oauth" }),
    ]);
    await expect(logins.complete("login-1", " code#state ")).resolves.toEqual(signedIn);
    expect(handle.complete).toHaveBeenCalledWith("code#state");
    settle().resolve(signedIn);
    await vi.waitFor(async () => expect((await logins.status()).logins).toEqual([]));
    await expect(logins.complete("login-1", "late")).rejects.toThrow("no longer under way");
  });

  it("tells every client following logins when a login changes, a sign-in starts, and a sign-in lost the engine", async () => {
    const { logins, settle, tellUpdate } = engine(signedOut);
    tellUpdate({ auth: signedIn, login: { loginId: "other", outcome: "succeeded" } });
    await logins.signIn("claude-code", "claudeai");
    settle().reject(new LoginError({ loginId: "login-1", outcome: "disconnected" }));
    await vi.waitFor(() => expect(published(mockPublish, agentAuthChanges)).toHaveLength(3));
    // The stream has no scope to narrow by: whoever follows it hears every login.
    expect(published(mockPublish, agentAuthChanges)).toEqual([
      {
        scope: {},
        event: { auth: signedIn, login: { loginId: "other", outcome: "succeeded" } },
      },
      {
        scope: {},
        event: {
          started: expect.objectContaining({ loginId: "login-1", url: "https://claude.ai/oauth" }),
        },
      },
      {
        scope: {},
        event: { login: { loginId: "login-1", outcome: "disconnected" } },
      },
    ]);
    // Nothing went out on any other stream.
    expect(mockPublish).toHaveBeenCalledTimes(3);
  });

  it("drops an ended sign-in before the windows read the status again", async () => {
    const { logins, tellUpdate } = engine(signedOut);
    await logins.signIn("claude-code", "claudeai");
    expect((await logins.status()).logins).toHaveLength(1);
    // The engine's notice can arrive before the handle's own end settles.
    tellUpdate({ auth: signedIn, login: { loginId: "login-1", outcome: "succeeded" } });
    expect((await logins.status()).logins).toEqual([]);
  });

  it("reads each CLI with its login and prepares only the requested agent", async () => {
    const { logins, client, tellProgress } = engine(signedIn);
    await expect(logins.status()).resolves.toEqual({ auth: [signedIn], clis: [cli], logins: [] });
    logins.prepareCli("codex-app-server");
    expect(client.prepareClis).toHaveBeenCalledExactlyOnceWith(["codex-app-server"]);
    const progress = {
      harness: "codex-app-server",
      version: "0.160.0",
      phase: "downloading",
      receivedBytes: 1,
      totalBytes: 4,
    };
    tellProgress(progress);
    // To the clients following installs, and not as a login change.
    expect(published(mockPublish, agentCliProgress)).toEqual([{ scope: {}, event: progress }]);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("signs in with a key without reading the status first", async () => {
    const { logins, client } = engine(signedIn);
    await logins.signIn("claude-code", "console", "sk-test");
    expect(client.authStatus).not.toHaveBeenCalled();
    expect(client.login).toHaveBeenCalledWith("claude-code", "console", { apiKey: "sk-test" });
  });

  it("publishes the reason when the engine refuses an install before progress", async () => {
    const { logins, client } = engine(signedOut);
    const reason = "harness not available: gemini";
    client.prepareClis.mockRejectedValueOnce(new Error(reason));
    logins.prepareCli("gemini");
    await Promise.resolve();
    expect(published(mockPublish, agentCliProgress)).toEqual([
      {
        scope: {},
        event: {
          harness: "gemini",
          phase: "failed",
          version: "",
          receivedBytes: 0,
          error: reason,
          category: "internal",
        },
      },
    ]);
  });

  it("reports the engine's cache failure even when the install emits no progress", async () => {
    const registry = createAgentRegistry({
      harnesses: ["gemini"],
      provision: {
        mode: "pinned",
        cacheDir: fileURLToPath(import.meta.url),
        bundleDirs: [],
        overrides: { agy: "" },
      },
    });
    const server = new AgentServer(new AgentRuntime(registry));
    const wire = channelPair();
    server.attach(wire.server);
    const client = await AgentServerClient.attach(wire.client);
    const agents = new LocalAgents(client);
    const progress = vi.fn();
    const off = client.onCliProgress(progress);
    try {
      agents.prepareCli("gemini");
      await vi.waitFor(() =>
        expect(published(mockPublish, agentCliProgress)).toEqual([
          {
            scope: {},
            event: expect.objectContaining({
              harness: "gemini",
              phase: "failed",
              error: expect.stringContaining("CLI cache"),
            }),
          },
        ])
      );
      expect(progress).not.toHaveBeenCalled();
    } finally {
      off();
      agents.dispose();
      await client.close();
      await server.shutdown();
    }
  });

  it.each(["returns a failed row", "rejects"])(
    "forwards only the engine's failed progress when prepare %s",
    async (ending) => {
      const { logins, client, tellProgress } = engine(signedOut);
      const progress: HarnessCliProgress = {
        harness: "gemini",
        phase: "failed",
        version: "1.0",
        receivedBytes: 5,
        totalBytes: 10,
        error: "Could not open the CLI cache",
        category: "internal",
      };
      const result = Promise.withResolvers<HarnessCli[]>();
      client.prepareClis.mockReturnValueOnce(result.promise);
      logins.prepareCli("gemini");
      tellProgress(progress);
      if (ending === "rejects") result.reject(new Error("The wire closed"));
      else result.resolve([{ harness: "gemini", state: "failed", error: "Install failed" }]);
      await result.promise.catch(() => {});
      expect(published(mockPublish, agentCliProgress)).toEqual([{ scope: {}, event: progress }]);
    }
  );
});
