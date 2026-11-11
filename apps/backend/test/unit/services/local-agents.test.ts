import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginError, type AgentServerClient, type LoginHandle } from "@zvada/agent-server/client";
import type {
  AuthUpdated,
  HarnessAuth,
  HarnessCli,
  HarnessCliProgress,
} from "@zvada/agent-server/protocol";

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast }));

import { LocalAgents } from "../../../src/services/agent/local-agents";

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

const told = () =>
  broadcast.mock.calls.map(([frame]) => JSON.parse(frame as string) as Record<string, unknown>);

beforeEach(() => broadcast.mockClear());

describe("LocalAgents", () => {
  it("asks each harness's CLI for its models, for the folder a turn would run in", async () => {
    const { logins, client } = engine(signedIn);
    await expect(logins.models("/repo/.deus/berlin")).resolves.toEqual([
      expect.objectContaining({ harness: "claude-code", source: "live" }),
      expect.objectContaining({ harness: "codex-app-server", source: "live" }),
    ]);
    expect(client.listModels.mock.calls).toEqual([
      [{ harness: "claude-code", cwd: "/repo/.deus/berlin" }],
      [{ harness: "codex-app-server", cwd: "/repo/.deus/berlin" }],
    ]);
    await logins.models();
    expect(client.listModels).toHaveBeenLastCalledWith({ harness: "codex-app-server" });
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

  it("tells every window when a login changes, a sign-in starts, and a sign-in lost the engine", async () => {
    const { logins, settle, tellUpdate } = engine(signedOut);
    tellUpdate({ auth: signedIn, login: { loginId: "other", outcome: "succeeded" } });
    await logins.signIn("claude-code", "claudeai");
    settle().reject(new LoginError({ loginId: "login-1", outcome: "disconnected" }));
    await vi.waitFor(() => expect(told()).toHaveLength(3));
    expect(told()).toEqual([
      {
        type: "q:event",
        event: "agent:auth",
        data: { auth: signedIn, login: { loginId: "other", outcome: "succeeded" } },
      },
      {
        type: "q:event",
        event: "agent:auth",
        data: {
          started: expect.objectContaining({ loginId: "login-1", url: "https://claude.ai/oauth" }),
        },
      },
      {
        type: "q:event",
        event: "agent:auth",
        data: { login: { loginId: "login-1", outcome: "disconnected" } },
      },
    ]);
  });

  it("drops an ended sign-in before the windows read the status again", async () => {
    const { logins, tellUpdate } = engine(signedOut);
    await logins.signIn("claude-code", "claudeai");
    expect((await logins.status()).logins).toHaveLength(1);
    // The engine's notice can arrive before the handle's own end settles.
    tellUpdate({ auth: signedIn, login: { loginId: "login-1", outcome: "succeeded" } });
    expect((await logins.status()).logins).toEqual([]);
  });

  it("reads each CLI with its login, and installs them on request without waiting", async () => {
    const { logins, client, tellProgress } = engine(signedIn);
    await expect(logins.status()).resolves.toEqual({ auth: [signedIn], clis: [cli], logins: [] });
    logins.prepareClis();
    expect(client.prepareClis).toHaveBeenCalledWith(["claude-code", "codex-app-server"]);
    const progress = {
      harness: "codex-app-server",
      version: "0.160.0",
      phase: "downloading",
      receivedBytes: 1,
      totalBytes: 4,
    };
    tellProgress(progress);
    expect(told()).toEqual([{ type: "q:event", event: "agent:cli", data: progress }]);
  });

  it("signs in with a key without reading the status first", async () => {
    const { logins, client } = engine(signedIn);
    await logins.signIn("claude-code", "console", "sk-test");
    expect(client.authStatus).not.toHaveBeenCalled();
    expect(client.login).toHaveBeenCalledWith("claude-code", "console", { apiKey: "sk-test" });
  });
});
