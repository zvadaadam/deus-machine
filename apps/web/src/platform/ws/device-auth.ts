/**
 * Device grants are scoped to the computer they open and, through the relay,
 * to the Deus account that paired them: the relay admits a computer's own
 * account only, so another account's grant on a shared browser is never sent.
 * Signing out keeps grants; signing back in to the same account reuses them.
 */
import {
  getDeploymentMode,
  getServerIdFromUrl,
  type DeploymentMode,
} from "@/shared/config/backend.config";
import { CLOUD_SESSION_KEY, readRelayAccount } from "./cloud-session";

const TOKEN_KEY = "deus_device_token";
const NAME_KEY = "deus_device_name";
const CHANGE_EVENT = "deus:device-auth-changed";
const STANDALONE = "standalone";

/**
 * Relay grants: `<prefix>:<account>:<computer>`. A direct (non-relay) host has
 * one `standalone` scope. Null while a relay page has no signed-in account.
 */
function scopeKey(prefix: string, serverId?: string, accountId?: string | null): string | null {
  const relay = getDeploymentMode() === "web-production";
  if (!relay && serverId === undefined) return `${prefix}:${STANDALONE}`;
  const host = serverId ?? getServerIdFromUrl() ?? STANDALONE;
  if (host === STANDALONE) return `${prefix}:${STANDALONE}`;
  const account = accountId === undefined ? (readRelayAccount()?.accountId ?? null) : accountId;
  if (!account) return null;
  return `${prefix}:${encodeURIComponent(account)}:${encodeURIComponent(host)}`;
}

/** Account login and a host's device grant are separate authentication boundaries. */
export function needsRemoteAuth(mode: DeploymentMode = getDeploymentMode()): boolean {
  if (mode === "electron" || mode === "web-direct") return false;
  // A local frontend can still address a remote relay. Its origin grants no trust.
  if (mode === "web-production") return true;
  return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
}

export function getStoredToken(serverId?: string, accountId?: string | null): string | null {
  const key = scopeKey(TOKEN_KEY, serverId, accountId);
  if (!key) return null;
  try {
    const scoped = localStorage.getItem(key);
    if (scoped || key !== `${TOKEN_KEY}:${STANDALONE}`) return scoped;
    // Older builds stored a single direct grant. Claim it once for this host.
    const legacy = localStorage.getItem(TOKEN_KEY);
    if (!legacy) return null;
    localStorage.setItem(key, legacy);
    const name = localStorage.getItem(NAME_KEY);
    if (name) localStorage.setItem(`${NAME_KEY}:${STANDALONE}`, name);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export function storeToken(
  token: string,
  deviceName?: string,
  serverId?: string,
  accountId?: string | null
): void {
  const key = scopeKey(TOKEN_KEY, serverId, accountId);
  const nameKey = scopeKey(NAME_KEY, serverId, accountId);
  if (!key) throw new Error("Sign in to save this device's access");
  localStorage.setItem(key, token);
  if (deviceName && nameKey) localStorage.setItem(nameKey, deviceName);
  notifyAuthChange();
}

export function clearToken(serverId?: string, accountId?: string | null): void {
  const key = scopeKey(TOKEN_KEY, serverId, accountId);
  const nameKey = scopeKey(NAME_KEY, serverId, accountId);
  if (key) localStorage.removeItem(key);
  if (nameKey) localStorage.removeItem(nameKey);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
  notifyAuthChange();
}

export function signOut(serverId?: string, accountId?: string | null): void {
  clearToken(serverId, accountId);
}

export function notifyAuthChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
}

/** Same-tab pairing/sign-out and cross-tab storage changes share one boundary. */
export function onDeviceAuthChange(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(TOKEN_KEY) || event.key === CLOUD_SESSION_KEY)
      callback();
  };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}
