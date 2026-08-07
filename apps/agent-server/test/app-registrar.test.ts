// app-registrar over the embedded engine: registrations broadcast the FULL
// current map through core-handler's setAapMcpServers, FIFO-ordered.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/core/engine", () => ({
  setAapMcpServers: vi.fn(async () => {}),
}));

import { setAapMcpServers } from "../agents/core/engine";
import { __clearRegistrarForTests, registerAppMcp, unregisterAppMcp } from "../app-registrar";

const broadcasts = vi.mocked(setAapMcpServers);

describe("app-registrar (core engine)", () => {
  beforeEach(() => {
    __clearRegistrarForTests();
    broadcasts.mockClear();
  });

  it("broadcasts the full map on register and unregister", async () => {
    await registerAppMcp("deus_mobile_use", "http://localhost:4001/mcp");
    await registerAppMcp("deus_web", "http://localhost:4002/mcp");
    expect(broadcasts).toHaveBeenNthCalledWith(1, {
      deus_mobile_use: { type: "http", url: "http://localhost:4001/mcp" },
    });
    expect(broadcasts).toHaveBeenNthCalledWith(2, {
      deus_mobile_use: { type: "http", url: "http://localhost:4001/mcp" },
      deus_web: { type: "http", url: "http://localhost:4002/mcp" },
    });

    await unregisterAppMcp("deus_mobile_use");
    expect(broadcasts).toHaveBeenNthCalledWith(3, {
      deus_web: { type: "http", url: "http://localhost:4002/mcp" },
    });
  });

  it("does not broadcast when unregistering an unknown server", async () => {
    await unregisterAppMcp("nope");
    expect(broadcasts).not.toHaveBeenCalled();
  });

  it("keeps updates FIFO even when a broadcast fails", async () => {
    broadcasts.mockRejectedValueOnce(new Error("swap failed"));
    await registerAppMcp("a", "http://a/mcp").catch(() => {});
    await registerAppMcp("b", "http://b/mcp");
    expect(broadcasts).toHaveBeenLastCalledWith({
      a: { type: "http", url: "http://a/mcp" },
      b: { type: "http", url: "http://b/mcp" },
    });
  });
});
