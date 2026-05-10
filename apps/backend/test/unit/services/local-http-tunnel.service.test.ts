import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => ({
  validateDeviceToken: vi.fn(),
}));

vi.mock("../../../src/services/remote-auth.service", () => ({
  validateDeviceToken: mockAuth.validateDeviceToken,
}));

describe("local-http-tunnel.service", () => {
  let server: Server | null = null;

  beforeEach(() => {
    mockAuth.validateDeviceToken.mockReset();
    mockAuth.validateDeviceToken.mockReturnValue({ id: "device-1", name: "Web" });
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
  });

  it("validates the device token before forwarding to localhost", async () => {
    mockAuth.validateDeviceToken.mockReturnValue(null);
    const { handleRelayedHttpRequest } =
      await import("../../../src/services/local-http-tunnel.service");

    const response = await handleRelayedHttpRequest({
      method: "GET",
      port: 3000,
      path: "/",
      query: "",
      headers: {},
      deviceToken: "bad-token",
    });

    expect(response.status).toBe(401);
    expect(Buffer.from(response.bodyBase64, "base64").toString("utf8")).toBe("Unauthorized");
  });

  it("forwards requests to the requested localhost port", async () => {
    const seen: Array<{ url?: string; method?: string; body: string }> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          url: req.url,
          method: req.method,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(201, { "content-type": "text/plain" });
        res.end("ok");
      });
    });
    const port = await listen(server);
    const { handleRelayedHttpRequest } =
      await import("../../../src/services/local-http-tunnel.service");

    const response = await handleRelayedHttpRequest({
      method: "POST",
      port,
      path: "/submit",
      query: "q=test",
      headers: { "content-type": "text/plain", "x-custom": "yes" },
      bodyBase64: Buffer.from("hello").toString("base64"),
      deviceToken: "dev-token",
    });

    expect(response.status).toBe(201);
    expect(Buffer.from(response.bodyBase64, "base64").toString("utf8")).toBe("ok");
    expect(seen).toEqual([{ url: "/submit?q=test", method: "POST", body: "hello" }]);
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("server did not bind to a TCP port"));
      }
    });
  });
}
