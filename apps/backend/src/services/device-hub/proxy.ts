import { Hono } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import WebSocket from "ws";
import { getClientIp, isLocalhost } from "../../lib/network";
import type { HubEndpoint } from "./manager";

const prefix = "/api/device-hub";
const getRoutes = [
  /^\/vendor\/serve-sim\/(api|appstate|grid\/api)$/,
  /^\/vendor\/serve-sim\/helper\/[\da-f-]+\/(config|health|stream-settings|stream\.avcc|stream\.mjpeg|webrtc\/stats)$/i,
  /^\/vendor\/serve-emu\/(api|health|webrtc\/stats)$/,
  /^\/vendor\/serve-emu\/api\/(devices|session|foreground|stream-mode|stream-settings)$/,
];
const postRoutes = [
  /^\/vendor\/serve-(sim|emu)\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/helper\/[\da-f-]+\/webrtc\/(offer|close)$/i,
  /^\/vendor\/serve-emu\/webrtc\/(offer|close)$/,
];
const sockets = new Set(["/vendor/serve-sim/helper/ws", "/vendor/serve-emu/ws"]);
const privateFields = new Set(["token", "execToken", "shareUrl", "appIconEndpoint"]);

function bridgeSocket(url: URL, headers: Record<string, string>): WSEvents<WebSocket> {
  let upstream: WebSocket;
  return {
    onOpen(_, client) {
      const downstream = client.raw!;
      const pending: { data: WebSocket.RawData; binary: boolean }[] = [];
      let bytes = 0;
      url.protocol = "ws:";
      upstream = new WebSocket(url, { headers, handshakeTimeout: 5000 });
      upstream.on("error", () => downstream.close(1011, "The device disconnected."));
      upstream.on("close", () => downstream.close());
      upstream.on("message", (data, binary) => {
        if (downstream.bufferedAmount > 8 * 1024 * 1024)
          downstream.close(1013, "Viewer is too slow.");
        else if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
      });
      upstream.on("open", () => {
        for (const frame of pending) upstream.send(frame.data, { binary: frame.binary });
        pending.length = 0;
      });
      downstream.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.CONNECTING) {
          bytes += Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;
          if (bytes > 64 * 1024) downstream.close(1009);
          else pending.push({ data, binary });
        } else if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
    },
    onClose() {
      upstream?.terminate();
    },
    onError() {
      upstream?.terminate();
    },
  };
}

export function deviceHubRoutes(
  endpoint: () => HubEndpoint | null,
  upgrade: UpgradeWebSocket<WebSocket>
) {
  const app = new Hono();
  app.all(prefix + "/*", async (c) => {
    if (!isLocalhost(getClientIp(c)))
      return c.json({ error: "Devices require a local connection." }, 403);
    const path = c.req.path.slice(prefix.length);
    const ws = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const routes = c.req.method === "GET" ? getRoutes : c.req.method === "POST" ? postRoutes : [];
    if (ws ? !sockets.has(path) : !routes.some((route) => route.test(path))) return c.notFound();
    const hub = endpoint();
    if (!hub) return c.json({ error: "Devices are not running." }, 503);
    const url = new URL(path, hub.origin);
    url.search = new URL(c.req.url).search;
    url.searchParams.delete("token");
    const headers: Record<string, string> = {
      authorization: `Bearer ${hub.token}`,
      origin: hub.origin,
    };
    if (ws) return upgrade(c, bridgeSocket(url, headers));
    const contentType = c.req.header("content-type");
    if (contentType) headers["content-type"] = contentType;
    try {
      const res = await fetch(url, {
        method: c.req.method,
        headers,
        redirect: "error",
        signal: c.req.raw.signal,
        body: c.req.method === "POST" ? await c.req.arrayBuffer() : undefined,
      });
      const type = res.headers.get("content-type") ?? "application/octet-stream";
      const responseHeaders = {
        "content-type": type,
        "cache-control": "no-store, no-transform",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      };
      if (type.includes("application/json")) {
        // serve-sim's discovery returns its host command credential even to a media viewer.
        const data = await res.json();
        const json = JSON.stringify(data, (key, value) =>
          privateFields.has(key) ? undefined : value
        );
        if (json.includes(hub.token))
          return c.json({ error: "Unexpected private device response." }, 502);
        return new Response(json, { status: res.status, headers: responseHeaders });
      }
      if (!res.ok) {
        await res.body?.cancel();
        return c.json({ error: `The device service returned HTTP ${res.status}.` }, 502);
      }
      return new Response(res.body, { status: res.status, headers: responseHeaders });
    } catch {
      return c.json({ error: "Lost the device connection." }, 502);
    }
  });
  return app;
}
