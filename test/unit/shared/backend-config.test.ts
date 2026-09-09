import { afterEach, describe, expect, it, vi } from "vitest";
import { setBackendPort } from "@/shared/config/api.config";
import { resolveBackendEndpoints } from "@/shared/config/backend.config";

vi.mock("@/platform/capabilities", () => ({ capabilities: { ipcInvoke: true } }));
vi.mock("@/platform/electron/invoke", () => ({ isElectronEnv: true }));

afterEach(() => vi.unstubAllEnvs());

describe("desktop backend endpoints", () => {
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
