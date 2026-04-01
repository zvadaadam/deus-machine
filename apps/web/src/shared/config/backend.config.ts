/**
 * Backend Config -- deployment mode detection and endpoint resolution.
 *
 * Determines how the frontend connects to the backend based on environment:
 * - Electron: localhost WS + HTTP via IPC-resolved port
 * - Web-dev: localhost WS + HTTP via VITE_BACKEND_PORT
 * - Web-production (relay): WS through relay.deusmachine.ai, HTTP tunneled over WS
 *
 * The resolved endpoints are cached after first call.
 */

import { capabilities } from "@/platform/capabilities";
import { getBackendPort } from "./api.config";

export type DeploymentMode = "electron" | "web-dev" | "web-production";

/** Detect the current deployment mode. */
export function getDeploymentMode(): DeploymentMode {
  if (capabilities.ipcInvoke) return "electron";
  if (import.meta.env.VITE_BACKEND_PORT) return "web-dev";
  return "web-production";
}

/** Whether the frontend is connecting through the cloud relay. */
export function isRelayMode(): boolean {
  return getDeploymentMode() === "web-production";
}

export interface BackendEndpoints {
  wsUrl: string;
  apiBase: string;
}

export const RELAY_BASE_URL =
  (import.meta.env.VITE_RELAY_URL as string | undefined) || "wss://relay.deusmachine.ai";

let cachedEndpoints: BackendEndpoints | null = null;
/** The serverId that the cached endpoints were built for (relay mode only). */
let cachedRelayServerId: string | null = null;

/**
 * Resolve the backend's WebSocket and HTTP base URLs.
 *
 * - Electron/web-dev: ws://localhost:{port}/ws + http://localhost:{port}/api
 * - Web-production: wss://relay.deusmachine.ai/api/servers/{serverId}/connect
 *   (HTTP goes through WS bridge, so apiBase is unused in relay mode)
 */
export async function resolveBackendEndpoints(serverId?: string): Promise<BackendEndpoints> {
  const mode = getDeploymentMode();

  if (mode === "web-production") {
    // In relay mode, serverId comes from the URL (/s/{serverId}/...)
    // or can be passed explicitly.
    const id = serverId || getServerIdFromUrl();
    if (!id) {
      throw new Error("No server ID available for relay connection");
    }
    // Cache is per-serverId — invalidate if serverId changes (strict equality)
    if (cachedEndpoints && cachedRelayServerId === id) {
      return cachedEndpoints;
    }
    const encodedId = encodeURIComponent(id);
    cachedRelayServerId = id;
    cachedEndpoints = {
      wsUrl: `${RELAY_BASE_URL}/api/servers/${encodedId}/connect`,
      // In relay mode, HTTP is tunneled over WS — apiBase is a placeholder
      // that should never be used directly (client.ts intercepts requests).
      apiBase: `${RELAY_BASE_URL}/api/servers/${encodedId}`,
    };
    return cachedEndpoints;
  }

  // Electron or web-dev: resolve local port
  if (cachedEndpoints) return cachedEndpoints;

  const port = await getBackendPort();
  cachedEndpoints = {
    wsUrl: `ws://localhost:${port}/ws`,
    apiBase: `http://localhost:${port}/api`,
  };
  return cachedEndpoints;
}

function invalidateEndpointCache(): void {
  cachedEndpoints = null;
  cachedRelayServerId = null;
}

/** Extract serverId from the current URL pathname (/s/{serverId}/...). */
function getServerIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/s\/([^/]+)/);
  return match ? match[1] : null;
}
