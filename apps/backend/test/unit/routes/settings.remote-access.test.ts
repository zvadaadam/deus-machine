import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler";

// Spies for the relay side-effects and the gate-cache invalidator. Hoisted so
// the vi.mock factories below can reference them.
const { relayConnectSpy, relayDisconnectSpy, invalidateGateSpy, mockedRemoteGateMiddleware } =
  vi.hoisted(() => ({
    relayConnectSpy: vi.fn(),
    relayDisconnectSpy: vi.fn(),
    invalidateGateSpy: vi.fn(),
    // The route only imports invalidateRemoteGateCache from remote-gate, but
    // vi.mock replaces the entire module so we re-export a passthrough
    // middleware (unused here since the test wraps only settingsRoutes).
    mockedRemoteGateMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  }));

vi.mock("../../../src/services/settings.service", () => ({
  getAllSettings: vi.fn(() => ({})),
  saveSetting: vi.fn(),
}));
vi.mock("../../../src/services/relay.service", () => ({
  ensureRelayConnected: relayConnectSpy,
  disconnectFromRelay: relayDisconnectSpy,
  getRelayStatus: vi.fn(() => ({ connected: false, clients: 0, serverId: null, relayUrl: null })),
}));
vi.mock("../../../src/middleware/remote-gate", () => ({
  invalidateRemoteGateCache: invalidateGateSpy,
  remoteGateMiddleware: mockedRemoteGateMiddleware,
}));

import settingsRoutes from "../../../src/routes/settings";

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route("/", settingsRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /settings: remote_access_enabled toggle contract", () => {
  it("invalidates the remote-gate cache when enabling remote access", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "remote_access_enabled", value: true }),
    });
    expect(res.status).toBe(200);
    // The cache MUST be invalidated before the relay side-effect runs so the
    // next remote request reads the freshly-persisted value.
    expect(invalidateGateSpy).toHaveBeenCalledTimes(1);
    expect(relayConnectSpy).toHaveBeenCalledTimes(1);
    expect(relayDisconnectSpy).not.toHaveBeenCalled();
  });

  it("invalidates the remote-gate cache when disabling remote access", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "remote_access_enabled", value: false }),
    });
    expect(res.status).toBe(200);
    expect(invalidateGateSpy).toHaveBeenCalledTimes(1);
    expect(relayDisconnectSpy).toHaveBeenCalledTimes(1);
    expect(relayConnectSpy).not.toHaveBeenCalled();
  });

  it("does NOT invalidate the gate cache for unrelated settings keys", async () => {
    // Toggling theme/lang/etc. must not churn the gate cache (cheap, but
    // confirms the invalidation is scoped to the remote_access_enabled branch
    // and not applied unconditionally in a way that would surprise future
    // maintainers).
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "light" }),
    });
    expect(res.status).toBe(200);
    expect(invalidateGateSpy).not.toHaveBeenCalled();
    expect(relayConnectSpy).not.toHaveBeenCalled();
    expect(relayDisconnectSpy).not.toHaveBeenCalled();
  });

  it("returns the canonical success shape for a remote_access_enabled toggle", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "remote_access_enabled", value: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      key: "remote_access_enabled",
      value: true,
    });
  });
});
