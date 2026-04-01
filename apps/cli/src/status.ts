/**
 * Server status display — shows running server info and connected devices.
 * Used by the `deus status` command.
 */

import { request } from "node:http";
import {
  c,
  sym,
  blank,
  divider,
  kv,
  success,
  error,
  hint,
} from "./ui.js";
import { readServerInfo } from "./config.js";

interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

interface RelayStatusResponse {
  connected: boolean;
  clients: number;
  serverId: string | null;
  relayUrl: string | null;
}

interface DeviceInfo {
  id: string;
  name: string;
  created_at: string;
  last_seen_at?: string;
}

interface AgentAuthResponse {
  agents: {
    name: string;
    initialized: boolean;
    authenticated: boolean;
    account?: { email?: string };
  }[];
}

/** GET request helper */
function httpGet<T>(port: number, path: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = request(
      { hostname: "localhost", port, path, method: "GET", timeout: 3000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/** Show server status */
export async function showStatus(): Promise<void> {
  const serverInfo = readServerInfo();

  if (!serverInfo) {
    error("No running Deus server found.");
    blank();
    hint(`Start the server with ${c.cyan("deus start")}`);
    blank();
    process.exit(1);
  }

  const port = serverInfo.backendPort;

  // Fetch all status info in parallel
  const [health, relayStatus, devices, agentAuth] = await Promise.all([
    httpGet<HealthResponse>(port, "/api/health"),
    httpGet<RelayStatusResponse>(port, "/api/settings/relay-status"),
    httpGet<{ devices: DeviceInfo[] }>(port, "/api/remote-auth/devices"),
    httpGet<AgentAuthResponse>(port, "/api/settings/agent-auth"),
  ]);

  const isRunning = health !== null;

  // ── Server ──
  blank();
  divider("Server");
  blank();
  kv("Status", isRunning ? c.green("running") : c.red("not responding"), 14);
  kv("Port", String(port), 14);
  kv("PID", String(serverInfo.pid), 14);
  kv("Uptime", formatUptime(Date.now() - new Date(serverInfo.startedAt).getTime()), 14);

  // ── Remote Access ──
  blank();
  divider("Remote Access");
  blank();
  if (relayStatus) {
    kv(
      "Relay",
      relayStatus.connected ? c.green("connected") : c.yellow("disconnected"),
      14
    );
    if (relayStatus.serverId) {
      kv("Server ID", c.dim(relayStatus.serverId.slice(0, 12) + "..."), 14);
    }
    kv("Clients", String(relayStatus.clients), 14);
  } else {
    kv("Relay", c.dim("unknown"), 14);
  }

  // ── Paired Devices ──
  const deviceList = devices?.devices || [];
  if (deviceList.length > 0) {
    blank();
    divider("Paired Devices");
    blank();
    for (const device of deviceList) {
      const age = formatTimeAgo(device.last_seen_at || device.created_at);
      console.log(`    ${c.green(sym.dot)} ${device.name.padEnd(24)} ${c.dim(age)}`);
    }
  }

  // ── AI Agents ──
  if (agentAuth?.agents) {
    blank();
    divider("AI Agents");
    blank();
    for (const agent of agentAuth.agents) {
      let status: string;
      if (!agent.initialized) {
        status = c.dim("not installed");
      } else if (agent.authenticated) {
        const email = agent.account?.email ? c.dim(` (${agent.account.email})`) : "";
        status = c.green("authenticated") + email;
      } else {
        status = c.yellow("not authenticated");
      }
      kv(agent.name, status, 14);
    }
  }

  blank();
  divider();
  blank();
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
