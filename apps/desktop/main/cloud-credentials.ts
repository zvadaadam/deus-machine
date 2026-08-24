// Durable home for cloud credentials on this device: the per-device agnt
// platform key (minted after Deus Cloud sign-in) and the Claude subscription
// token (Settings → Agents). Built on the shared safeStorage-file primitive;
// the renderer never sees values — only presence/meta. The backend receives
// them at spawn (env) and at runtime (local credentials route).

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

export type CloudCredentialName = "agntApiKey" | "claudeOauthToken" | "codexAuthJson";

export interface CloudCredentialMeta {
  /** agnt-side key id — needed to revoke the device key on sign-out. */
  keyId?: string;
  /** Organization the key was minted in. */
  orgId?: string;
  /** Mint label (hostname) shown in Settings. */
  label?: string;
  /**
   * Set when a copy of this credential was successfully written to the
   * platform. Disconnect needs it: after an account sign-out the device key
   * is gone, so a platform delete is impossible — and without this flag the
   * only choices were to claim success (leaving a token that keeps billing
   * cloud turns) or to warn about a cloud copy that may never have existed.
   */
  syncedToPlatform?: boolean;
  /**
   * The org the platform copy was written to. Sign-out leaves subscription
   * credentials on disk (only the device key is deleted), so signing into a
   * DIFFERENT account would otherwise upload the same token into a second
   * org — live in both, deletable from only one.
   */
  syncedOrgId?: string;
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
  hasCodexSubscription: boolean;
  /**
   * The OS keyring cannot decrypt right now, so stored credentials exist on
   * disk but are UNUSABLE this session. Distinct from "not connected":
   * reporting these as connected would show a working subscription while
   * every cloud turn runs without one.
   */
  vaultLocked: boolean;
}

const filePath = () => userDataFilePath(CREDENTIALS_FILE_NAME);

async function readStore(): Promise<StoredCredentialsFile> {
  const parsed = await readJsonFile<StoredCredentialsFile>(filePath());
  if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
    return { version: 1, entries: {} };
  }
  return parsed;
}

export async function setCloudCredential(
  name: CloudCredentialName,
  value: string,
  meta: CloudCredentialMeta = {}
): Promise<void> {
  const store = await readStore();
  store.entries[name] = {
    // Carry meta the caller did not restate: a value-only rewrite (re-pasting
    // a token while signed out) must NOT wipe syncedToPlatform/syncedOrgId —
    // the platform still holds the OLD copy under this name, and disconnect
    // relies on those flags to refuse a false "disconnected".
    ...store.entries[name],
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
    // deleting here would destroy the device key and every subscription token
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
  const { encryptedValue: _encrypted, ...meta } = entry;
  return meta;
}

export async function deleteCloudCredential(name: CloudCredentialName): Promise<void> {
  const store = await readStore();
  if (!store.entries[name]) return;
  delete store.entries[name];
  if (Object.keys(store.entries).length === 0) {
    await removeFile(filePath());
    return;
  }
  await writeJsonFile(filePath(), store);
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

/**
 * The ownership rule, in ONE place. A credential's platform copy is foreign
 * only when BOTH org ids are known and differ — an unknown side proves
 * nothing, and the two previous inline spellings disagreed on exactly that.
 */
export function foreignToOrg(
  meta: { syncedOrgId?: string } | null | undefined,
  orgId: string | null | undefined
): boolean {
  return Boolean(meta?.syncedOrgId && orgId && meta.syncedOrgId !== orgId);
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
  // Same ownership rule as the backend push: a token stamped for ANOTHER
  // account's org is not "connected" here — reporting it would show a green
  // check while every cloud turn runs without a credential.
  const ownedHere = (name: "claudeOauthToken" | "codexAuthJson") => {
    const entry = store.entries[name];
    if (!entry) return false;
    return !foreignToOrg(entry, key?.orgId);
  };
  return {
    hasPlatformKey: usable && Boolean(key),
    platformKeyLabel: key?.label ?? null,
    platformOrgId: key?.orgId ?? null,
    hasClaudeSubscription: usable && ownedHere("claudeOauthToken"),
    hasCodexSubscription: usable && ownedHere("codexAuthJson"),
    vaultLocked: !usable && Object.keys(store.entries).length > 0,
  };
}
