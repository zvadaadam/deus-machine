import { vi, describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { AgentServerDisconnectedError } from "../../../src/lib/errors";
import { errorHandler } from "../../../src/middleware/error-handler";

// The routes that are still fetched over HTTP. What the operations answer is
// tested in ../api/settings.test.ts.

vi.mock("../../../src/services/settings.service", () => ({
  getAllSettings: vi.fn(() => ({ theme: "dark", lang: "en" })),
  saveSetting: vi.fn(),
  getSetting: vi.fn(() => null),
  PRIVATE_SETTINGS: new Set(["relay_machines"]),
}));
vi.mock("../../../src/services/automations", () => ({ initAutomations: vi.fn() }));
vi.mock("../../../src/services/relay.service", () => ({ reconcileRelay: vi.fn() }));
vi.mock("../../../src/services/keep-awake.service", () => ({ syncKeepAwake: vi.fn() }));
// The agent-auth route's module also answers for the local agents: keep the
// engine out of this test.
vi.mock("../../../src/services/agent", () => ({ getLocalAgents: vi.fn() }));

import settingsRoutes from "../../../src/routes/settings";
import { getLocalAgents } from "../../../src/services/agent";

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route("/", settingsRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /settings/agent-auth", () => {
  it("answers each local agent's CLI and login, as the operation does", async () => {
    const answer = {
      auth: [{ harness: "claude-code", state: "signed_in", methods: [] }],
      clis: [{ harness: "claude-code", state: "ready" }],
      logins: [],
    };
    vi.mocked(getLocalAgents).mockReturnValue({ status: async () => answer } as never);
    const res = await app.request("/settings/agent-auth");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it("answers why the engine could not be asked, with a 200", async () => {
    vi.mocked(getLocalAgents).mockImplementation(() => {
      throw new AgentServerDisconnectedError();
    });
    const res = await app.request("/settings/agent-auth");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ auth: [], error: "Agent server is disconnected" });
  });
});

describe("POST /settings/cloud/credentials", () => {
  const push = (routes: Hono, authorization?: string) =>
    routes.request("/settings/cloud/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ deusCloudSessionToken: null }),
    });

  // The spawn token arrives once, on stdin (lib/parent-stdin.ts): load the routes afresh.
  async function routesSpawned(stdin: PassThrough | null) {
    vi.resetModules();
    const { stopWhenStdinEnds } = await import("../../../src/lib/parent-stdin");
    stopWhenStdinEnds(() => {}, stdin ? { DEUS_STOP_ON_STDIN_END: "1" } : {}, stdin ?? undefined);
    const routes = new Hono();
    routes.route("/", (await import("../../../src/routes/settings")).default);
    // A fresh errorHandler too, so it knows the freshly loaded AppError.
    routes.onError((await import("../../../src/middleware/error-handler")).errorHandler);
    return routes;
  }

  it("accepts only the token the desktop wrote on stdin, even when asked before it arrived", async () => {
    const stdin = new PassThrough();
    const routes = await routesSpawned(stdin);
    const early = push(routes, "Bearer spawn-secret");
    stdin.write("spawn-");
    stdin.write("secret\nanything after the first line is not a token\n");
    expect((await early).status).toBe(200);
    expect((await push(routes)).status).toBe(401);
    expect((await push(routes, "Bearer wrong-secret")).status).toBe(401);
    expect((await push(routes, "Bearer anything after the first line is not a token")).status).toBe(
      401
    );
  });

  it("takes no account when no desktop process spawned the backend", async () => {
    const routes = await routesSpawned(null);
    expect((await push(routes)).status).toBe(401);
    expect((await push(routes, "Bearer anything")).status).toBe(401);
  });

  it("takes no account when stdin ends before a token", async () => {
    const stdin = new PassThrough();
    const routes = await routesSpawned(stdin);
    const early = push(routes, "Bearer anything");
    stdin.end();
    expect((await early).status).toBe(401);
  });
});
