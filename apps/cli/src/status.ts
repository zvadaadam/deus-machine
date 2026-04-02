/**
 * Server status display — shows running server info and connected devices.
 * Used by the `deus status` command.
 */

import { c, sym, blank, divider, kv, error, hint } from "./ui.js";
import { readServerInfo } from "./config.js";
import { httpGet } from "./lib/http.js";
import { formatUptime, formatTimeAgo } from "./lib/format.js";

interface HealthResponse {
  status: string;
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
  const [health, relayStatus, devicesRes, agentAuth] = await Promise.all([
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
    kv("Relay", relayStatus.connected ? c.green("connected") : c.yellow("disconnected"), 14);
    if (relayStatus.serverId) {
      kv("Server ID", c.dim(relayStatus.serverId.slice(0, 12) + "..."), 14);
    }
    kv("Clients", String(relayStatus.clients), 14);
  } else {
    kv("Relay", c.dim("unknown"), 14);
  }

  // ── Paired Devices ──
  const devices = devicesRes?.devices || [];
  if (devices.length > 0) {
    blank();
    divider("Paired Devices");
    blank();
    for (const device of devices) {
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
