/**
 * CLI configuration persistence.
 *
 * Stores CLI-specific state at ~/.config/deus/config.json (XDG-compliant).
 * Separate from the backend's preferences.json — this tracks onboarding
 * completion, auth method choice, and server runtime info.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { randomBytes } from "node:crypto";

// ── Config Types ─────────────────────────────────────────────────────

export interface DeusConfig {
  onboarding_completed: boolean;
  auth_method: "claude_cli" | "api_key" | "env" | "skipped" | null;
  anthropic_api_key?: string;
  relay_enabled: boolean;
  installed_at?: string;
}

export interface ServerInfo {
  pid: number;
  backendPort: number;
  agentServerUrl: string;
  startedAt: string;
}

const DEFAULT_CONFIG: DeusConfig = {
  onboarding_completed: false,
  auth_method: null,
  relay_enabled: true,
};

// ── Paths ────────────────────────────────────────────────────────────

export function getConfigDir(): string {
  const os = platform();
  if (os === "darwin") {
    return join(homedir(), ".config", "deus");
  }
  if (os === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "deus");
  }
  // Linux / other — XDG
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "deus");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getServerInfoPath(): string {
  return join(getConfigDir(), "server.json");
}

// ── Config CRUD ──────────────────────────────────────────────────────

export function loadConfig(): DeusConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: DeusConfig): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });

  const path = getConfigPath();
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");

  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    // Clean up temp file on failure
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`Failed to save config to ${path}`);
  }
}

export function hasCompletedOnboarding(): boolean {
  return loadConfig().onboarding_completed;
}

// ── Server Info ──────────────────────────────────────────────────────

export function writeServerInfo(info: ServerInfo): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });

  const path = getServerInfoPath();
  writeFileSync(path, JSON.stringify(info, null, 2) + "\n", "utf-8");
  chmodSync(path, 0o600);
}

export function readServerInfo(): ServerInfo | null {
  const path = getServerInfoPath();
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const info = JSON.parse(raw) as ServerInfo;

    // Verify the process is still alive
    try {
      process.kill(info.pid, 0);
    } catch {
      // Process is dead — clean up stale info
      clearServerInfo();
      return null;
    }

    return info;
  } catch {
    return null;
  }
}

export function clearServerInfo(): void {
  const path = getServerInfoPath();
  try {
    unlinkSync(path);
  } catch {
    // Already gone
  }
}
