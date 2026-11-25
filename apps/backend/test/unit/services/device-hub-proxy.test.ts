import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWebOrigins } from "@shared/web-origins";
import { createLoopbackOriginGate } from "../../../src/middleware/loopback-origin-gate";
import { deviceHubRoutes } from "../../../src/services/device-hub/proxy";

describe("Device Hub proxy", () => {
  const token = "fixture-private-bearer";
  let vendor: Server;
  let server: ReturnType<typeof serve>;
  let sockets: WebSocketServer;
  let base: string;
  let auth: string | undefined;
  let seenOrigin: string | undefined;
  let vendorOrigin: string;
  let app: Hono;
  beforeEach(async () => {
    auth = undefined;
    vendor = createServer((req, res) => {
      auth = req.headers.authorization;
      seenOrigin = req.headers.origin;
      if (req.url?.includes("/webrtc/offer")) {
        res.writeHead(200, { "content-type": "application/json" });
        req.pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": token });
      res.end(JSON.stringify({ device: "a", execToken: token, shareUrl: "unused" }));
    });
    sockets = new WebSocketServer({ server: vendor });
    sockets.on("connection", (ws, req) => {
      auth = req.headers.authorization;
      ws.on("message", (data, binary) => ws.send(data, { binary }));
    });
    vendor.listen(0, "127.0.0.1");
    await once(vendor, "listening");
    vendorOrigin = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;
    app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.use("*", createLoopbackOriginGate(parseWebOrigins("app://deus").origins));
    app.route(
      "/",
      deviceHubRoutes(() => ({ origin: vendorOrigin, token }), upgradeWebSocket)
    );
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectWebSocket(server);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device-hub`;
  });
  afterEach(async () => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    await Promise.all(
      [server, vendor].map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    );
  });
  it("authenticates upstream and removes private discovery fields and cookies", async () => {
    const res = await fetch(base + "/vendor/serve-sim/api", { headers: { Origin: "app://deus" } });
    expect(auth).toBe("Bearer " + token);
    expect(seenOrigin).toBe(vendorOrigin);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ device: "a" });
  });
  it("forwards WebRTC offers and preserves text and binary input frames", async () => {
    const res = await fetch(base + "/vendor/serve-sim/helper/abc/webrtc/offer", {
      method: "POST",
      body: JSON.stringify({ sdp: "description" }),
      headers: { "content-type": "application/json" },
    });
    expect(await res.json()).toEqual({ sdp: "description" });
    const ws = new WebSocket(base.replace("http:", "ws:") + "/vendor/serve-sim/helper/ws");
    await once(ws, "open");
    for (const [message, binary] of [
      ["hello", false],
      [Buffer.from([3, 0, 255]), true],
    ] as const) {
      ws.send(message);
      const [echo, isBinary] = await once(ws, "message");
      expect(isBinary).toBe(binary);
      expect(echo).toEqual(Buffer.from(message));
    }
    expect(auth).toBe("Bearer " + token);
    ws.close();
    await once(ws, "close");
  });
  it("refuses foreign origins, nonlocal connections and unrelated hub routes before forwarding", async () => {
    const path = "/vendor/serve-sim/api";
    const foreign = await fetch(base + path, { headers: { Origin: "https://example.test" } });
    expect(foreign.status).toBe(403);
    const remote = await app.request(
      base + path,
      {},
      { incoming: { socket: { remoteAddress: "192.0.2.1" } } }
    );
    expect(remote.status).toBe(403);
    expect((await fetch(base + "/vendor/serve-sim/exec-ws")).status).toBe(404);
    const ws = new WebSocket(base.replace("http:", "ws:") + "/vendor/serve-sim/helper/ws", {
      origin: "https://example.test",
    });
    const [error] = await once(ws, "error");
    expect(error.message).toContain("403");
    expect(auth).toBeUndefined();
  });
});
