import { afterEach, describe, expect, it, vi } from "vitest";
import { setBackendPort } from "@/shared/config/api.config";
import { resolveBackendEndpoints } from "@/shared/config/backend.config";

vi.mock("@/platform/capabilities", () => ({ capabilities: { ipcInvoke: true } }));
vi.mock("@/platform/electron/invoke", () => ({ isElectronEnv: true }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("desktop backend endpoints", () => {
  it("keeps an explicitly bound relay host across route/mode changes without polluting same-origin endpoints", async () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        host: "app.example",
        origin: "https://app.example",
        pathname: "/s/B",
      },
    });
    const relay = await resolveBackendEndpoints("A / encoded", "web-production");
    expect(relay.wsUrl).toMatch(/\/api\/servers\/A%20%2F%20encoded\/connect$/);
    expect(await resolveBackendEndpoints(undefined, "web-standalone")).toEqual({
      wsUrl: "wss://app.example/ws",
      apiBase: "https://app.example/api",
    });
    expect(await resolveBackendEndpoints("A / encoded", "web-production")).toEqual(relay);
  });

  it("uses the restarted backend port for the next WebSocket connection", async () => {
    vi.stubEnv("VITE_BACKEND_PORT", "");
    setBackendPort(41000);
    expect(await resolveBackendEndpoints()).toEqual({
      wsUrl: "ws://localhost:41000/ws",
      apiBase: "http://localhost:41000/api",
    });

    setBackendPort(42000);
    expect(await resolveBackendEndpoints()).toEqual({
      wsUrl: "ws://localhost:42000/ws",
      apiBase: "http://localhost:42000/api",
    });
  });
});
