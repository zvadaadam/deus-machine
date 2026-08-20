// Durable home for cloud credentials on this device: the per-device agnt
// platform key (minted after Deus Cloud sign-in) and the Claude subscription
// token (Settings → Agents). Same posture as the WorkOS session file:
// safeStorage-encrypted values inside a 0600 JSON in userData. The renderer
// never sees values — only presence/meta; the backend receives them at spawn
// (env) and at runtime (local credentials route).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

const CREDENTIALS_FILE_NAME = "deus-cloud-credentials.json";

export type CloudCredentialName = "agntApiKey" | "claudeOauthToken";

export interface CloudCredentialMeta {
  /** agnt-side key id — needed to revoke the device key on sign-out. */
  keyId?: string;
  /** Organization the key was minted in. */
  orgId?: string;
  /** Mint label (hostname) shown in Settings. */
  label?: string;
  createdAt?: string;
}

interface StoredCredentialEntry extends CloudCredentialMeta {
  encryptedValue: string;
}

interface StoredCredentialsFile {
  version: 1;
  entries: Partial<Record<CloudCredentialName, StoredCredentialEntry>>;
}

export interface CloudCredentialsStatus {
  hasPlatformKey: boolean;
  platformKeyLabel: string | null;
  platformOrgId: string | null;
  hasClaudeSubscription: boolean;
}

function getCredentialsFilePath(): string {
  return join(app.getPath("userData"), CREDENTIALS_FILE_NAME);
}

function requireSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this device");
  }
}

function encryptValue(value: string): string {
  requireSafeStorage();
  return safeStorage.encryptString(value).toString("base64");
}

function decryptValue(encrypted: string): string {
  requireSafeStorage();
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

async function readStore(): Promise<StoredCredentialsFile> {
  try {
    const raw = await readFile(getCredentialsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as StoredCredentialsFile;
    if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeStore(store: StoredCredentialsFile): Promise<void> {
  const filePath = getCredentialsFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export async function setCloudCredential(
  name: CloudCredentialName,
  value: string,
  meta: CloudCredentialMeta = {}
): Promise<void> {
  const store = await readStore();
  store.entries[name] = {
    encryptedValue: encryptValue(value),
    createdAt: new Date().toISOString(),
    ...meta,
  };
  await writeStore(store);
}

export async function getCloudCredential(name: CloudCredentialName): Promise<string | null> {
  const store = await readStore();
  const entry = store.entries[name];
  if (!entry) return null;
  try {
    return decryptValue(entry.encryptedValue);
  } catch {
    // Encryption key changed (OS reinstall, keychain reset) — the entry is
    // unrecoverable; drop it so status reads honestly disconnected.
    await deleteCloudCredential(name);
    return null;
  }
}

export async function getCloudCredentialMeta(
  name: CloudCredentialName
): Promise<CloudCredentialMeta | null> {
  const store = await readStore();
  const entry = store.entries[name];
  if (!entry) return null;
  const { encryptedValue: _encrypted, ...meta } = entry;
  return meta;
}

export async function deleteCloudCredential(name: CloudCredentialName): Promise<void> {
  const store = await readStore();
  if (!store.entries[name]) return;
  delete store.entries[name];
  if (Object.keys(store.entries).length === 0) {
    await rm(getCredentialsFilePath(), { force: true });
    return;
  }
  await writeStore(store);
}

/** Presence/meta only — safe for the renderer; values never cross IPC. */
export async function getCloudCredentialsStatus(): Promise<CloudCredentialsStatus> {
  const store = await readStore();
  const key = store.entries.agntApiKey;
  return {
    hasPlatformKey: Boolean(key),
    platformKeyLabel: key?.label ?? null,
    platformOrgId: key?.orgId ?? null,
    hasClaudeSubscription: Boolean(store.entries.claudeOauthToken),
  };
}
