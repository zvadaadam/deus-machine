/**
 * Sidecar Service — Backend
 *
 * Spawns and manages the sidecar-v2 Node.js process and its Unix domain socket.
 * Handles JSON-RPC 2.0 relay between frontend (via HTTP/WS) and sidecar.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited JSON (NDJSON)
 *
 * Architecture:
 *   Frontend → WS/HTTP → Backend → Unix Socket → Sidecar → Claude SDK
 *   Sidecar → saves to DB → POST /notify → Backend → WS push → Frontend
 *   Sidecar requests → Unix Socket → Backend → WS event → Frontend
 */

import { spawn, type ChildProcess } from "child_process";
import { createConnection, type Socket } from "net";
import { dirname } from "path";
import { StringDecoder } from "string_decoder";
import { broadcast } from "./ws.service";

// ---- State ----

let sidecarProcess: ChildProcess | null = null;
let socketPath: string | null = null;
let socket: Socket | null = null;
let connected = false;

/** Response queue for JSON-RPC request/response pairing. */
const responseQueue: Array<{
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];
const bufferedResponses: string[] = [];

const RESPONSE_TIMEOUT_MS = 30_000;

// ---- Sidecar Lifecycle ----

/**
 * Spawn the sidecar process. Uses env vars set by Electron main:
 * - SIDECAR_BUNDLE_PATH — path to the sidecar bundle
 * - DATABASE_PATH — path to the SQLite database
 */
export async function spawnSidecar(): Promise<string> {
  if (sidecarProcess) {
    if (socketPath) return socketPath;
    throw new Error("Sidecar already running but socket path not yet available");
  }

  const sidecarEntry = process.env.SIDECAR_BUNDLE_PATH;
  if (!sidecarEntry) {
    throw new Error("SIDECAR_BUNDLE_PATH not set — cannot spawn sidecar");
  }

  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath) {
    throw new Error("DATABASE_PATH not set — cannot spawn sidecar");
  }

  // Backend's own port for notify URL
  const backendPort = process.env.PORT || "0";
  const { getServerPort } = await import("../server");
  const actualPort = getServerPort() || parseInt(backendPort, 10);
  const notifyUrl = `http://localhost:${actualPort}/api/notify`;

  return new Promise((resolve, reject) => {
    sidecarProcess = spawn(process.execPath, [sidecarEntry], {
      cwd: dirname(sidecarEntry),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DATABASE_PATH: dbPath,
        BACKEND_NOTIFY_URL: notifyUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;

    sidecarProcess.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        console.log("[sidecar]", trimmed);

        if (trimmed.startsWith("SOCKET_PATH=")) {
          const path = trimmed.slice("SOCKET_PATH=".length);
          socketPath = path;
          if (!resolved) {
            resolved = true;
            console.log(`[sidecar] Detected socket path: ${path}`);
            resolve(path);
          }
        }
      }
    });

    sidecarProcess.stderr?.on("data", (data: Buffer) => {
      console.error("[sidecar:stderr]", data.toString().trim());
    });

    sidecarProcess.on("exit", (code, signal) => {
      console.log(`[sidecar] Exited with code=${code} signal=${signal}`);
      sidecarProcess = null;
      socketPath = null;
      disconnectSocket();
      if (!resolved) reject(new Error(`Sidecar exited before ready (code=${code})`));
    });

    sidecarProcess.on("error", (err) => {
      console.error("[sidecar] Spawn error:", err);
      if (!resolved) { resolved = true; reject(err); }
    });

    setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error("Sidecar did not emit SOCKET_PATH within 15s")); }
    }, 15_000);
  });
}

export function stopSidecar(): void {
  disconnectSocket();
  if (sidecarProcess) {
    console.log("[sidecar] Stopping sidecar process");
    sidecarProcess.kill("SIGTERM");
    const proc = sidecarProcess;
    const forceTimer = setTimeout(() => {
      if (proc && !proc.killed) proc.kill("SIGKILL");
    }, 3_000);
    proc.on("exit", () => clearTimeout(forceTimer));
    sidecarProcess = null;
    socketPath = null;
  }
}

// ---- Socket Connection ----

export function connectToSidecar(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (connected && socket && socketPath === path) { resolve(); return; }
    disconnectSocket();
    socketPath = path;

    const sock = createConnection(path, () => {
      socket = sock;
      connected = true;
      console.log(`[sidecar-socket] Connected to ${path}`);
      setupSocketReader(sock);
      resolve();
    });

    sock.on("error", (err) => {
      console.error("[sidecar-socket] Connection error:", err.message);
      if (!connected) reject(err);
      disconnectSocket();
    });

    sock.on("close", () => {
      console.log("[sidecar-socket] Connection closed");
      disconnectSocket();
    });
  });
}

function disconnectSocket(): void {
  connected = false;
  if (socket) { socket.destroy(); socket = null; }
  while (responseQueue.length > 0) {
    const waiter = responseQueue.shift()!;
    clearTimeout(waiter.timer);
    waiter.reject(new Error("Socket disconnected"));
  }
  bufferedResponses.length = 0;
}

/**
 * NDJSON reader — routes messages by shape:
 * - Has "method" + "id" = sidecar→frontend REQUEST → broadcast WS event
 * - Has "id" but no "method" = response to frontend request → response queue
 * - Has "method" but no "id" = notification → log
 */
function setupSocketReader(sock: Socket): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  sock.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.jsonrpc !== "2.0") continue;

        const hasMethod = typeof msg.method === "string";
        const hasId = msg.id !== undefined && msg.id !== null;

        if (hasMethod && hasId) {
          // Sidecar → Frontend REQUEST (bidirectional RPC)
          console.log(`[sidecar-socket] Sidecar request: ${msg.method} (id=${msg.id})`);
          broadcast(JSON.stringify({
            type: "q:event",
            event: "sidecar:request",
            data: { id: msg.id, method: msg.method, params: msg.params ?? null },
          }));
        } else if (hasId) {
          // Response to frontend-initiated request
          dispatchResponse(line);
        }
        // Notifications (hasMethod, no id) are handled by POST /notify
      } catch {
        // Ignore malformed JSON
      }
    }
  });
}

function dispatchResponse(line: string): void {
  if (responseQueue.length > 0) {
    const waiter = responseQueue.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  } else {
    bufferedResponses.push(line);
  }
}

// ---- Send / Receive ----

export function sendMessage(message: string): void {
  if (!socket || !connected) throw new Error("Not connected to sidecar socket");
  socket.write(message + "\n");
}

export function receiveMessage(): Promise<string> {
  if (bufferedResponses.length > 0) return Promise.resolve(bufferedResponses.shift()!);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = responseQueue.findIndex((w) => w.resolve === resolve);
      if (idx !== -1) responseQueue.splice(idx, 1);
      reject(new Error("Timed out waiting for response from sidecar (30s)"));
    }, RESPONSE_TIMEOUT_MS);
    responseQueue.push({ resolve, reject, timer });
  });
}

/** Write a response back to the sidecar (for bidirectional RPC). */
export function sendResponseToSidecar(response: string): void {
  if (socket && connected) {
    socket.write(response + "\n");
  }
}

// ---- Status ----

export function isSidecarConnected(): boolean { return connected; }
export function getSidecarSocketPath(): string | null { return socketPath; }
