import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
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
      throw new Error("Agent server not connected");
    });
    const res = await app.request("/settings/agent-auth");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ auth: [], error: "Agent server not connected" });
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

  // The token is read once, when the backend loads: load the routes afresh with it.
  async function routesSpawnedWith(token: string | undefined) {
    vi.resetModules();
    if (token === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = token;
    const routes = new Hono();
    routes.route("/", (await import("../../../src/routes/settings")).default);
    // A fresh errorHandler too, so it knows the freshly loaded AppError.
    routes.onError((await import("../../../src/middleware/error-handler")).errorHandler);
    return routes;
  }

  it("accepts only the desktop process that spawned the backend", async () => {
    const routes = await routesSpawnedWith("spawn-secret");
    expect((await push(routes)).status).toBe(401);
    expect((await push(routes, "Bearer wrong-secret")).status).toBe(401);
    expect((await push(routes, "Bearer spawn-secret")).status).toBe(200);
  });

  it("keeps the token from everything the backend starts", async () => {
    await routesSpawnedWith("spawn-secret");
    expect(process.env.AUTH_TOKEN).toBeUndefined();
  });

  it("takes no account when no desktop process spawned the backend", async () => {
    const routes = await routesSpawnedWith(undefined);
    expect((await push(routes)).status).toBe(401);
    expect((await push(routes, "Bearer anything")).status).toBe(401);
  });
});
