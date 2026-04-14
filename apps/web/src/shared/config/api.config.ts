/**
 * API Configuration
 * Central configuration for API endpoints and settings
 *
 * Port resolution:
 * - Electron app: Uses preload bridge via window.electronAPI.getBackendPort()
 * - Web dev: Uses VITE_BACKEND_PORT environment variable from dev.sh
 */

// Import directly from the source module (not the barrel) to avoid circular
// dependency: client.ts → api.config.ts → platform/electron/index.ts → ... → client.ts
import { isElectronEnv } from "@/platform/electron/invoke";

let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

// IPC retry config for backend port resolution.
// The backend may not have emitted its [BACKEND_PORT] marker yet during early
// startup — the main process waits for it before returning the port.
// 30 attempts × 200ms = 6s covers the startup timeout with margin.
const PORT_MAX_RETRIES = 30;
const PORT_RETRY_DELAY_MS = 200;

/**
 * Get the backend port (cached after first call).
 *
 * In Electron mode, retries the IPC call with backoff because the backend may
 * still be starting when the renderer first loads. Without retries, a single
 * failed invoke permanently caches port 3333, causing all API requests to
 * hit the wrong port and leaving the window hidden.
 */
export async function getBackendPort(): Promise<number> {
  if (cachedPort !== null) {
    return cachedPort;
  }

  // If there's already a pending request, return it
  if (portPromise !== null) {
    return portPromise;
  }

  portPromise = (async () => {
    // 1. Check if running in web dev mode with dynamic port
    if (import.meta.env.VITE_BACKEND_PORT) {
      const port = parseInt(import.meta.env.VITE_BACKEND_PORT as string, 10);
      if (!isNaN(port)) {
        if (import.meta.env.DEV) console.log(`[API] Using web dev backend port: ${port}`);
        cachedPort = port;
        return port;
      }
    }

    // 2. Electron: use the dedicated preload API (bypasses generic invoke bridge).
    // The backend is spawned by the main process before the window is created,
    // so the port should be available immediately via native:getBackendPort.
    // Retry with backoff for the rare case where the renderer loads before the
    // backend has emitted its [BACKEND_PORT] marker.
    if (isElectronEnv) {
      for (let attempt = 0; attempt < PORT_MAX_RETRIES; attempt++) {
        try {
          const port = await window.electronAPI!.getBackendPort();
          if (import.meta.env.DEV)
            console.log(`[API] Using Electron backend port: ${port} (attempt ${attempt + 1})`);
          cachedPort = port;
          return port;
        } catch {
          if (attempt < PORT_MAX_RETRIES - 1) {
            await new Promise((resolve) => setTimeout(resolve, PORT_RETRY_DELAY_MS));
          }
        }
      }
      // All retries exhausted — don't cache a wrong port. Throw so TanStack Query
      // retries the entire fetch later, giving the backend more time to start.
      console.error("[API] getBackendPort failed after retries — backend may not have started");
      throw new Error("Backend port not available after retries");
    }

    // 3. Dev mode: fetch port from Vite middleware (Electron writes it to temp file).
    // This enables Chrome tabs at localhost:1420 to work during `bun run dev`.
    if (import.meta.env.DEV) {
      try {
        const res = await fetch("/__backend_port");
        if (res.ok) {
          const data = await res.json();
          if (data.port && typeof data.port === "number") {
            console.log(`[API] Using backend port from dev server: ${data.port}`);
            cachedPort = data.port;
            return data.port;
          }
        }
      } catch {
        // Vite middleware not available
      }
    }

    // 4. Last resort fallback — do NOT cache so retries re-resolve
    // (e.g. user clicks Retry after backend finishes starting)
    console.warn("[API] No port source available, falling back to default port 3333");
    return 3333;
  })();

  // Clear promise when done (success or failure)
  portPromise.finally(() => {
    portPromise = null;
  });

  return portPromise;
}

/**
 * Set the backend port directly and clear any in-flight resolution.
 * Called when the main process notifies the renderer of a backend restart
 * with a new port — the WebSocket reconnect loop will pick up the new port
 * on its next `getBackendPort()` call (which returns immediately from cache).
 */
export function setBackendPort(port: number): void {
  cachedPort = port;
  portPromise = null;
  if (import.meta.env.DEV) {
    console.log(`[API] Backend port updated to ${port} (backend restarted)`);
  }
}

/**
 * Get the backend origin URL (e.g. http://localhost:12345)
 * Throws in relay mode — HTTP goes through the WS bridge, not direct fetch.
 */
export async function getBackendUrl(): Promise<string> {
  // Lazy import to avoid circular dependency
  const { isRelayMode } = await import("./backend.config");
  if (isRelayMode()) {
    throw new Error("getBackendUrl() unavailable in relay mode — use WS bridge");
  }
  const port = await getBackendPort();
  return `http://localhost:${port}`;
}

/**
 * Get the base URL for API requests (async).
 * Throws in relay mode — HTTP is tunneled over WS via client.ts bridge.
 */
export async function getBaseURL(): Promise<string> {
  // Lazy import to avoid circular dependency
  const { isRelayMode } = await import("./backend.config");
  if (isRelayMode()) {
    throw new Error("getBaseURL() unavailable in relay mode — use WS bridge");
  }
  const port = await getBackendPort();
  return `http://localhost:${port}/api`;
}
