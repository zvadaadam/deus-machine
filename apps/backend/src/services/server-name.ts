// backend/src/services/server-name.ts
// This computer's name as people see it: the one its relay registration
// carries (and so Devices and /connect show) and the one an assistant's MCP
// server is titled with.

import { execSync } from "child_process";
import { hostname, userInfo, platform } from "os";
import { getSetting } from "./settings.service";

/** The name set in Settings, else the Mac's computer name, else its host name. */
export function getServerName(): string {
  const custom = getSetting("server_name") as string | undefined;
  if (custom) return custom;

  if (platform() === "darwin") {
    try {
      const name = execSync("scutil --get ComputerName", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      if (name) return name;
    } catch {
      /* fall through */
    }
  }

  const host = hostname().replace(/\.local$/, "");
  if (host && host !== "localhost") return host;

  try {
    return `${userInfo().username}'s computer`;
  } catch {
    return "Deus Server";
  }
}
