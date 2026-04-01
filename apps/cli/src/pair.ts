/**
 * Pairing code generation — fetches a code from the backend and displays it
 * with a QR code for easy remote access.
 */

import { request } from "node:http";
import {
  c,
  sym,
  box,
  blank,
  success,
  error,
  hint,
  divider,
} from "./ui.js";
import { readServerInfo } from "./config.js";
import { printQR } from "./qr.js";

interface PairCodeResponse {
  code: string;
  expires_in_seconds: number;
}

interface DeviceInfo {
  id: string;
  name: string;
  created_at: string;
  last_seen_at?: string;
}

/** Fetch a new pairing code from the backend */
async function fetchPairCode(backendPort: number): Promise<PairCodeResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "localhost",
        port: backendPort,
        path: "/api/remote-auth/generate-pair-code",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Backend returned ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid response from backend"));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Fetch list of paired devices from the backend */
async function fetchDevices(backendPort: number): Promise<DeviceInfo[]> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "localhost",
        port: backendPort,
        path: "/api/remote-auth/devices",
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve([]);
            return;
          }
          try {
            const data = JSON.parse(body);
            resolve(data.devices || []);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.end();
  });
}

/** Generate and display a pairing code with QR code */
export async function showPairCode(backendPort: number): Promise<void> {
  const pairData = await fetchPairCode(backendPort);
  const pairingUrl = `https://app.rundeus.com/pair?code=${encodeURIComponent(pairData.code)}`;
  const expiresMin = Math.floor(pairData.expires_in_seconds / 60);

  blank();
  divider("Connect from anywhere");
  blank();

  hint("Scan QR code or open the link:");
  blank();

  // QR code for the full URL
  printQR(pairingUrl, 4);
  blank();

  // Clickable URL
  console.log(`    ${c.cyan(c.underline(pairingUrl))}`);
  blank();

  // Manual code entry
  hint("Or enter code manually:");
  blank();
  box([`    ${c.bold(c.brightWhite(pairData.code))}    `], {
    borderColor: c.cyan,
    width: pairData.code.length + 10,
  });

  blank();
  hint(`Expires in ${expiresMin} minutes.`);
  blank();
  divider();
}

/** Standalone `deus pair` command — connects to a running server */
export async function pair(): Promise<void> {
  const serverInfo = readServerInfo();

  if (!serverInfo) {
    error("No running Deus server found.");
    blank();
    hint(`Start the server first with ${c.cyan("deus start")}`);
    blank();
    process.exit(1);
  }

  try {
    await showPairCode(serverInfo.backendPort);
  } catch (err: any) {
    error(`Could not generate pairing code: ${err.message}`);
    blank();
    hint("Make sure the Deus server is running.");
    blank();
    process.exit(1);
  }

  // Show connected devices
  const devices = await fetchDevices(serverInfo.backendPort);
  if (devices.length > 0) {
    blank();
    divider("Connected devices");
    blank();
    for (const device of devices) {
      const age = formatTimeAgo(device.last_seen_at || device.created_at);
      console.log(`    ${c.green(sym.dot)} ${device.name}${c.dim(`     ${age}`)}`);
    }
    blank();
    divider();
    blank();
  }
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
