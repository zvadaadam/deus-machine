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
// POST /settings runs the saveSetting operation's function, whose module also
// answers for the local agents: keep the engine out of this test.
vi.mock("../../../src/services/agent", () => ({ getLocalAgents: vi.fn() }));

import settingsRoutes from "../../../src/routes/settings";
import { getAllSettings, saveSetting } from "../../../src/services/settings.service";
import { reconcileRelay } from "../../../src/services/relay.service";
import { getLocalAgents } from "../../../src/services/agent";

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route("/", settingsRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /settings", () => {
  it("returns 200 with settings object", async () => {
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ theme: "dark", lang: "en" });
  });

  it("calls getAllSettings", async () => {
    await app.request("/settings");
    expect(getAllSettings).toHaveBeenCalled();
  });
});

describe("POST /settings", () => {
  it("returns 200 with success when given key and value", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "light" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, key: "theme", value: "light" });
  });

  it("refuses to write this computer's machine secrets", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "relay_machines", value: {} }),
    });
    expect(res.status).toBe(400);
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it("calls saveSetting with correct arguments", async () => {
    await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "light" }),
    });
    expect(saveSetting).toHaveBeenCalledWith("theme", "light");
  });

  it("returns 400 when key is missing", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "light" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when key is empty string", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "", value: "light" }),
    });
    expect(res.status).toBe(400);
  });

  it("turns remote access on as the operation does: the tunnel follows", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "remote_access_enabled", value: true }),
    });
    expect(res.status).toBe(200);
    expect(saveSetting).toHaveBeenCalledWith("remote_access_enabled", true);
    expect(reconcileRelay).toHaveBeenCalledExactlyOnceWith({ restart: true });
  });
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
  const push = (authorization?: string) =>
    app.request("/settings/cloud/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ deusCloudSessionToken: null }),
    });

  it("accepts only the desktop process that spawned the backend", async () => {
    vi.stubEnv("AUTH_TOKEN", "spawn-secret");
    try {
      expect((await push()).status).toBe(401);
      expect((await push("Bearer wrong-secret")).status).toBe(401);
      expect((await push("Bearer spawn-secret")).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes no account when no desktop process spawned the backend", async () => {
    vi.stubEnv("AUTH_TOKEN", "");
    try {
      expect((await push()).status).toBe(401);
      expect((await push("Bearer anything")).status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
