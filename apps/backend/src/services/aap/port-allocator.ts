// apps/backend/src/services/aap/port-allocator.ts
// Allocate a free localhost port by letting the kernel pick one
// (`listen(0)`), capturing it, then releasing immediately.
//
// Race window: the port is unbound between allocate and the child's bind.
// Callers should pass the port to a child that retries-once on EADDRINUSE,
// or handle the race at spawn time. Low frequency in practice.

import { createServer } from "node:net";

export async function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null || typeof addr.port !== "number") {
        server.close();
        reject(new Error("port-allocator: unexpected listen address"));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
