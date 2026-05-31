// packages/pencil/src/lib/transport-server.ts
//
// Implements Pencil's TransportServer protocol over a WebSocket. The
// bundled mcp-server-darwin-arm64 (CLI 0.2.5+) is a `WebSocketClient`
// that discovers its host via the file at `~/.pencil/apps/<app-name>`.
// The file's contents are the host's TCP port (5 ASCII chars, no newline).
// On startup with `-app <name>`, the binary reads `~/.pencil/apps/<name>`,
// connects to `ws://[::1]:<port>`, and routes MCP tool_calls through us.
//
// Wire format (each WS frame is one JSON message — WS already frames):
//   • Initial handshake (host → client), wrapped:
//       {type:"client_id_assignment", data:{client_id, request_id:"client-id-assignment", success:true}}
//   • Tool request (client → host) — CLI 0.2.5+ sends a *flat* shape:
//       {client_id, request_id, name:"<kebab-case>", payload}
//     Older Cursor extension binary used the wrapped {type:"tool_request",
//     data:{...}} shape; we accept both. Verified against the binary's
//     JSON tags: `json:"client_id" json:"request_id" json:"success"`.
//   • Tool response (host → client) — match the inbound shape:
//       {client_id, request_id, success:true, result}    (flat)
//       {type:"tool_response", data:{...}}               (wrapped)
//
// We bridge each tool_request to the iframe editor's already-registered
// IPC handlers via lib/iframe-rpc.ts.

import * as fs from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { PENCIL_APPS_DIR, PENCIL_HOST_APP_NAME_PREFIX } from "./config.ts";
import { requestFromIframe } from "./iframe-rpc.ts";

interface ClientState {
  clientId: string;
  ws: WebSocket;
}

let httpServer: http.Server | null = null;
let wsServer: WebSocketServer | null = null;
const clients = new Map<string, ClientState>();
let registeredAppFile: string | null = null;
let registeredAppPort: number | null = null;

// CLI 0.2.5+ sends *flat* tool_request frames (no `type` / `data` wrapper).
// Older Cursor extension binary used the wrapped shape. We accept both
// inbound and respond in the same shape we received so the binary's
// router matches `request_id`.
interface FlatToolRequest {
  client_id?: string;
  request_id: string;
  name: string;
  payload?: unknown;
  type?: undefined;
}
interface WrappedToolRequest {
  type: "tool_request";
  data: {
    client_id?: string;
    request_id: string;
    name: string;
    payload?: unknown;
  };
}
type Frame = FlatToolRequest | WrappedToolRequest | { type?: string; data?: unknown };

/** Boot the WS host. Returns the port we ended up bound to. */
export async function startTransportServer(hostAppName = PENCIL_HOST_APP_NAME_PREFIX): Promise<number> {
  if (httpServer) {
    const addr = httpServer.address();
    return addr && typeof addr === "object" ? addr.port : 0;
  }

  // Node's http server upgraded into a ws server. We bind to IPv6 [::1]
  // because that's what the CLI's own headless mode does — the binary
  // (a Go program with dial("tcp", "[::1]:<port>")) reaches us either
  // way, but IPv6 matches the convention.
  return new Promise((resolve, reject) => {
    httpServer = http.createServer();
    wsServer = new WebSocketServer({ server: httpServer });
    wsServer.on("connection", (ws) => onConnect(ws));
    httpServer.on("error", reject);
    httpServer.listen(0, "::1", () => {
      const addr = httpServer!.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("could not get bound port"));
        return;
      }
      registerAppPort(hostAppName, addr.port);
      console.log(`[pencil-transport] WebSocket host listening on ws://[::1]:${addr.port}`);
      resolve(addr.port);
    });
  });
}

export async function stopTransportServer(): Promise<void> {
  for (const c of clients.values()) {
    try {
      c.ws.close();
    } catch {
      /* already closed */
    }
  }
  clients.clear();
  if (wsServer) {
    await new Promise<void>((r) => wsServer!.close(() => r()));
    wsServer = null;
  }
  if (httpServer) {
    await new Promise<void>((r) => httpServer!.close(() => r()));
    httpServer = null;
  }
  unregisterAppPort();
}

function registerAppPort(hostAppName: string, port: number): void {
  fs.mkdirSync(PENCIL_APPS_DIR, { recursive: true });
  registeredAppFile = join(PENCIL_APPS_DIR, hostAppName);
  registeredAppPort = port;
  // Match the format Pencil's own apps use: just the port number, no
  // newline (5-character file for typical ports).
  fs.writeFileSync(registeredAppFile, String(port), "utf8");
  console.log(`[pencil-transport] registered app "${hostAppName}" → port ${port}`);
}

function unregisterAppPort(): void {
  if (!registeredAppFile) return;
  try {
    const current = fs.readFileSync(registeredAppFile, "utf8");
    if (registeredAppPort === null || current === String(registeredAppPort)) {
      fs.unlinkSync(registeredAppFile);
    }
  } catch {
    /* fine */
  }
  registeredAppFile = null;
  registeredAppPort = null;
}

// ---- connection handling --------------------------------------------------

function onConnect(ws: WebSocket): void {
  const clientId = `deus-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  console.log(`[pencil-transport] client connected → ${clientId}`);
  clients.set(clientId, { clientId, ws });

  // Send the handshake. The shape that worked in our reverse-engineering
  // probe: wrapper with "type" + "data".
  send(ws, {
    type: "client_id_assignment",
    data: {
      client_id: clientId,
      request_id: "client-id-assignment",
      success: true,
    },
  });

  ws.on("message", async (raw) => {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let frame: Frame;
    try {
      frame = JSON.parse(text);
    } catch (err) {
      console.warn(
        `[pencil-transport] invalid JSON frame: ${(err as Error).message}; raw=${text.slice(0, 200)}`
      );
      return;
    }
    try {
      await handleFrame(clientId, ws, frame);
    } catch (err) {
      console.warn(`[pencil-transport] frame handler error: ${(err as Error).message}`);
    }
  });

  ws.on("close", () => {
    console.log(`[pencil-transport] client disconnected: ${clientId}`);
    clients.delete(clientId);
  });
  ws.on("error", (err) => {
    console.warn(`[pencil-transport] WS error (${clientId}): ${err.message}`);
  });
}

async function handleFrame(clientId: string, ws: WebSocket, frame: Frame): Promise<void> {
  // Flat shape (CLI 0.2.5+): {client_id?, request_id, name, payload}
  // Wrapped shape (older binaries): {type:"tool_request", data:{...}}
  let req: { client_id?: string; request_id: string; name: string; payload?: unknown } | null =
    null;
  let wrapped = false;
  if (frame && typeof frame === "object" && "name" in frame && "request_id" in frame) {
    req = frame as FlatToolRequest;
  } else if (frame.type === "tool_request" && frame.data && typeof frame.data === "object") {
    req = frame.data as WrappedToolRequest["data"];
    wrapped = true;
  }
  if (!req) {
    console.warn(`[pencil-transport] unknown frame: ${JSON.stringify(frame).slice(0, 200)}`);
    return;
  }

  const { request_id, name, payload } = req;
  const respondedClientId = req.client_id ?? clientId;
  try {
    // The binary uses kebab-case method names that match the editor's
    // already-registered IPC handlers — forward verbatim. The editor
    // wraps its return values as `{success, error, result}` (verified
    // against the editor bundle: every `n.handle(...)` returns this
    // shape). That IS the binary's wire format — don't re-wrap.
    const editorReply = await requestFromIframe(name, payload);
    sendResponse(ws, wrapped, mergeEditorReply(respondedClientId, request_id, editorReply));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse(ws, wrapped, {
      client_id: respondedClientId,
      request_id,
      success: false,
      error: message,
    });
  }
}

function mergeEditorReply(
  clientId: string,
  requestId: string,
  editorReply: unknown
): Record<string, unknown> {
  const base = { client_id: clientId, request_id: requestId };
  if (editorReply && typeof editorReply === "object") {
    const r = editorReply as Record<string, unknown>;
    // Editor's standard shape: pass through.
    if (typeof r.success === "boolean") {
      return { ...base, ...r };
    }
  }
  // Non-standard payload (e.g. an editor handler that returned a raw
  // value). Wrap it so the binary still sees a valid response.
  return { ...base, success: true, result: editorReply };
}

function sendResponse(ws: WebSocket, wrapped: boolean, body: Record<string, unknown>): void {
  if (wrapped) {
    send(ws, { type: "tool_response", data: body });
  } else {
    send(ws, body);
  }
}

function send(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export function isTransportServerRunning(): boolean {
  return httpServer !== null;
}

export function activeClientCount(): number {
  return clients.size;
}

export function transportServerPort(): number | null {
  if (!httpServer) return null;
  const addr = httpServer.address();
  return addr && typeof addr === "object" ? addr.port : null;
}
