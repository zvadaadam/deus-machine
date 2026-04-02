/**
 * Pairing code generation — fetches a code from the backend and displays it
 * with a QR code for easy remote access.
 */

import { c, sym, box, blank, error, hint, divider } from "./ui.js";
import { readServerInfo } from "./config.js";
import { printQR } from "./qr.js";
import { httpPost, httpGet } from "./lib/http.js";
import { formatTimeAgo } from "./lib/format.js";

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

/** Generate and display a pairing code with QR code */
export async function showPairCode(backendPort: number): Promise<void> {
  const pairData = await httpPost<PairCodeResponse>(
    backendPort,
    "/api/remote-auth/generate-pair-code"
  );
  const pairingUrl = `https://app.rundeus.com/pair?code=${encodeURIComponent(pairData.code)}`;
  const expiresMin = Math.floor(pairData.expires_in_seconds / 60);

  blank();
  divider("Connect from anywhere");
  blank();

  hint("Scan QR code or open the link:");
  blank();

  printQR(pairingUrl, 4);
  blank();

  console.log(`    ${c.cyan(c.underline(pairingUrl))}`);
  blank();

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
  const devicesRes = await httpGet<{ devices: DeviceInfo[] }>(
    serverInfo.backendPort,
    "/api/remote-auth/devices"
  );
  const devices = devicesRes?.devices || [];

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
