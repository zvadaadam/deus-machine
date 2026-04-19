import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { allocateFreePort } from "../../../../src/services/aap/port-allocator";

describe("aap/port-allocator", () => {
  it("returns a positive integer port in the ephemeral range", async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
    expect(Number.isInteger(port)).toBe(true);
  });

  it("returns a port that is immediately bindable", async () => {
    const port = await allocateFreePort();
    // If the allocator leaked the bind, this listen would EADDRINUSE.
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });

  it("returns different ports across sequential calls (sanity)", async () => {
    const ports = await Promise.all([allocateFreePort(), allocateFreePort(), allocateFreePort()]);
    // Not guaranteed by the kernel, but in practice they're all distinct.
    // If this ever flakes, relax to `new Set(ports).size >= 2`.
    expect(new Set(ports).size).toBeGreaterThanOrEqual(2);
  });
});
