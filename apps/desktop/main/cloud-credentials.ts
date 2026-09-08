// The per-device platform key, encrypted with the shared safeStorage primitive.
// Provider credentials live only in the signed-in user's cloud account store.

import {
  decryptSecret,
  isSafeStorageAvailable,
  encryptSecret,
  readJsonFile,
  removeFile,
  userDataFilePath,
  writeJsonFile,
} from "./safe-storage-file";

const CREDENTIALS_FILE_NAME = "deus-cloud-credentials.json";

export type CloudCredentialName = "agntApiKey";

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
  /** The OS keyring cannot decrypt the stored platform key this session. */
  vaultLocked: boolean;
}

const filePath = () => userDataFilePath(CREDENTIALS_FILE_NAME);

async function readStore(): Promise<StoredCredentialsFile> {
  const parsed = await readJsonFile<StoredCredentialsFile>(filePath());
  if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
    return { version: 1, entries: {} };
  }
  const store: StoredCredentialsFile = {
    version: 1,
    entries: parsed.entries.agntApiKey ? { agntApiKey: parsed.entries.agntApiKey } : {},
  };
  if (Object.keys(parsed.entries).some((name) => name !== "agntApiKey")) {
    if (store.entries.agntApiKey) await writeJsonFile(filePath(), store);
    else await removeFile(filePath());
  }
  return store;
}

export async function setCloudCredential(
  name: CloudCredentialName,
  value: string,
  meta: CloudCredentialMeta = {}
): Promise<void> {
  const store = await readStore();
  store.entries[name] = {
    encryptedValue: encryptSecret(value),
    createdAt: new Date().toISOString(),
    ...meta,
  };
  await writeJsonFile(filePath(), store);
}

export async function getCloudCredential(name: CloudCredentialName): Promise<string | null> {
  const store = await readStore();
  const entry = store.entries[name];
  if (!entry) return null;
  if (!isSafeStorageAvailable()) {
    // The keyring is not ready (Linux login keyring still locked, first boot).
    // Nothing was even attempted, so this says nothing about the ciphertext —
    // deleting here would destroy the device key
    // over a condition that resolves on its own a second later.
    return null;
  }
  try {
    return decryptSecret(entry.encryptedValue);
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
  return { keyId: entry.keyId, orgId: entry.orgId, label: entry.label, createdAt: entry.createdAt };
}

export async function deleteCloudCredential(_name: CloudCredentialName): Promise<void> {
  await removeFile(filePath());
}

/**
 * Whether anything is stored at all — a plain file read, NO keyring contact.
 *
 * Callers use this to avoid touching safe storage when there is nothing to
 * protect. That matters at startup: `safeStorage.isEncryptionAvailable()`
 * consults the macOS Keychain synchronously on the main thread, so probing
 * it on a fresh install (or in CI, where no keychain is unlocked) stalls
 * everything behind it — including window creation.
 */
export async function hasStoredCredentials(): Promise<boolean> {
  const store = await readStore();
  return Object.keys(store.entries).length > 0;
}

/** Presence/meta only — safe for the renderer; values never cross IPC. */
export async function getCloudCredentialsStatus(): Promise<CloudCredentialsStatus> {
  const store = await readStore();
  const key = store.entries.agntApiKey;
  // Entries are ciphertext; with the keyring locked, getCloudCredential()
  // hands the backend nothing, so claiming "connected" off mere presence
  // would have Settings disagree with what the cloud lane actually holds.
  // Only probe the keyring when something is stored — see hasStoredCredentials.
  const usable = Object.keys(store.entries).length === 0 || isSafeStorageAvailable();
  return {
    hasPlatformKey: usable && Boolean(key),
    platformKeyLabel: key?.label ?? null,
    platformOrgId: key?.orgId ?? null,
    vaultLocked: !usable && Object.keys(store.entries).length > 0,
  };
}
