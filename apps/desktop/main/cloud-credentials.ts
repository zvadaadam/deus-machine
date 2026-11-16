// The per-device platform keys, one per organization of the signed-in account,
// encrypted with the shared safeStorage primitive. Provider credentials live
// only in the signed-in user's cloud account store.
//
// The file keeps the single-key shape of earlier builds, because dev builds and
// the released app share this folder: the default organization's key sits in
// `entries.agntApiKey`, where older builds read it, and the other organizations'
// keys in a top-level `orgKeys` they ignore, so alternating builds rewrite nothing.

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

export interface OrgKeyMeta {
  /** Organization the key was minted in (the map's key). */
  orgId: string;
  /** agnt-side key id — needed to revoke the device key on sign-out. */
  keyId?: string;
  /** Mint label (hostname) shown in Settings. */
  label?: string;
  createdAt?: string;
}

interface StoredOrgKey extends OrgKeyMeta {
  encryptedValue: string;
}

/** Keys by organization id, in the platform's order (the first is the default organization). */
type OrgKeyStore = Record<string, StoredOrgKey>;

type UnknownEntry = (Partial<StoredOrgKey> & { encryptedValue?: unknown }) | undefined;

/**
 * On disk. `entries` holds only `agntApiKey` (older builds remove any other
 * name there): the default organization's key. `orgKeys` holds the rest.
 */
interface CredentialsFile {
  version: 1;
  entries: { agntApiKey?: StoredOrgKey };
  orgKeys?: OrgKeyStore;
}

/** What may be found on disk: this shape, an older build's, or the brief `version: 2` map. */
interface ParsedCredentialsFile {
  version?: unknown;
  entries?: Record<string, UnknownEntry> | null;
  orgKeys?: Record<string, UnknownEntry> | null;
}

export interface CloudCredentialsStatus {
  hasPlatformKey: boolean;
  /** The default organization's key label. */
  platformKeyLabel: string | null;
  /** The default organization (the first with a key). */
  platformOrgId: string | null;
  /** Every organization this device holds a usable key for. */
  platformOrgIds: string[];
  /** The OS keyring cannot decrypt the stored platform keys this session. */
  vaultLocked: boolean;
}

const filePath = () => userDataFilePath(CREDENTIALS_FILE_NAME);

let credentialFileTail: Promise<void> = Promise.resolve();

/** Reads can scrub the file, so every vault operation shares one queue. */
function withCredentialFile<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialFileTail.then(operation);
  credentialFileTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

const storedKey = (entry: UnknownEntry, orgId: string): StoredOrgKey | null =>
  entry && typeof entry.encryptedValue === "string"
    ? {
        encryptedValue: entry.encryptedValue,
        orgId,
        keyId: entry.keyId,
        label: entry.label,
        createdAt: entry.createdAt,
      }
    : null;

/** The first key goes where older builds read theirs; no keys, no file. */
async function writeStore(store: OrgKeyStore): Promise<void> {
  const [first, ...rest] = Object.values(store);
  if (!first) {
    await removeFile(filePath());
    return;
  }
  const file: CredentialsFile = { version: 1, entries: { agntApiKey: first } };
  if (rest.length > 0) file.orgKeys = Object.fromEntries(rest.map((key) => [key.orgId, key]));
  await writeJsonFile(filePath(), file);
}

/**
 * The stored keys: the default from `entries.agntApiKey`, then `orgKeys`.
 * What an earlier build kept that must not stay (retired provider entries, a
 * key naming no organization) is removed from disk, and a `version: 2` file
 * (an unreleased build's) is rewritten in this shape.
 */
async function readStore(): Promise<OrgKeyStore> {
  const parsed = await readJsonFile<ParsedCredentialsFile>(filePath());
  if (!parsed || typeof parsed !== "object") return {};
  if (parsed.version !== 1 && parsed.version !== 2) return {};
  const store: OrgKeyStore = {};
  let rewrite = parsed.version === 2;
  if (parsed.version === 1) {
    const entries = typeof parsed.entries === "object" && parsed.entries ? parsed.entries : {};
    const legacy = entries.agntApiKey;
    const key = legacy && typeof legacy.orgId === "string" ? storedKey(legacy, legacy.orgId) : null;
    if (key) store[key.orgId] = key;
    // Unknown names, or no default an older build can read: rewrite.
    if (!key || Object.keys(entries).some((name) => name !== "agntApiKey")) rewrite = true;
  }
  const orgKeys = typeof parsed.orgKeys === "object" && parsed.orgKeys ? parsed.orgKeys : {};
  for (const [orgId, entry] of Object.entries(orgKeys)) {
    const key = storedKey(entry, orgId);
    if (key && !store[orgId]) store[orgId] = key;
    else rewrite = true;
  }
  if (rewrite) await writeStore(store);
  return store;
}

/** Store (or replace) one organization's key. */
export async function setOrgKey(
  orgId: string,
  value: string,
  meta: Omit<OrgKeyMeta, "orgId"> = {}
): Promise<void> {
  return withCredentialFile(async () => {
    const store = await readStore();
    store[orgId] = {
      encryptedValue: encryptSecret(value),
      createdAt: new Date().toISOString(),
      ...meta,
      orgId,
    };
    await writeStore(store);
  });
}

function decrypt(store: OrgKeyStore, orgId: string): string | null {
  const entry = store[orgId];
  if (!entry) return null;
  try {
    return decryptSecret(entry.encryptedValue);
  } catch {
    // Encryption key changed (OS reinstall, keychain reset) — the entry is
    // unrecoverable; drop it so status reads honestly disconnected.
    delete store[orgId];
    return null;
  }
}

/** One organization's key, or null (none stored, keyring not ready, unreadable). */
export async function getOrgKey(orgId: string): Promise<string | null> {
  return withCredentialFile(async () => {
    const store = await readStore();
    if (!store[orgId]) return null;
    // The keyring is not ready (Linux login keyring still locked, first boot).
    // Nothing was even attempted, so this says nothing about the ciphertext —
    // deleting here would destroy the device key over a condition that
    // resolves on its own a second later.
    if (!isSafeStorageAvailable()) return null;
    const value = decrypt(store, orgId);
    if (value === null) await writeStore(store);
    return value;
  });
}

/** Every readable key by organization, in the stored (platform) order. */
export async function getOrgKeys(): Promise<Record<string, string>> {
  return withCredentialFile(async () => {
    const store = await readStore();
    const ids = Object.keys(store);
    if (ids.length === 0 || !isSafeStorageAvailable()) return {};
    const keys: Record<string, string> = {};
    for (const orgId of ids) {
      const value = decrypt(store, orgId);
      if (value !== null) keys[orgId] = value;
    }
    if (Object.keys(keys).length !== ids.length) await writeStore(store);
    return keys;
  });
}

/** Metadata of every stored key (never a value), in the stored order. */
export async function listOrgKeys(): Promise<OrgKeyMeta[]> {
  return withCredentialFile(async () => {
    const store = await readStore();
    return Object.values(store).map(({ orgId, keyId, label, createdAt }) => ({
      orgId,
      keyId,
      label,
      createdAt,
    }));
  });
}

export async function deleteOrgKey(orgId: string): Promise<void> {
  return withCredentialFile(async () => {
    const store = await readStore();
    if (!store[orgId]) return;
    delete store[orgId];
    await writeStore(store);
  });
}

export async function deleteAllOrgKeys(): Promise<void> {
  return withCredentialFile(() => removeFile(filePath()));
}

/**
 * Put the stored keys in the platform's order (the first is the default
 * organization). Rewrites nothing when the order already matches; deletes and
 * mints nothing either way.
 */
export async function orderOrgKeys(orgIds: string[]): Promise<void> {
  return withCredentialFile(async () => {
    const store = await readStore();
    const current = Object.keys(store);
    const wanted = [
      ...orgIds.filter((id) => store[id]),
      ...current.filter((id) => !orgIds.includes(id)),
    ];
    if (wanted.every((id, i) => id === current[i])) return;
    const ordered: OrgKeyStore = {};
    for (const id of wanted) ordered[id] = store[id];
    await writeStore(ordered);
  });
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
  return withCredentialFile(async () => {
    const store = await readStore();
    return Object.keys(store).length > 0;
  });
}

/** Presence/meta only — safe for the renderer; values never cross IPC. */
export async function getCloudCredentialsStatus(): Promise<CloudCredentialsStatus> {
  return withCredentialFile(async () => {
    const store = await readStore();
    const keys = Object.values(store);
    // Entries are ciphertext; with the keyring locked, the backend is handed
    // nothing, so claiming "connected" off mere presence would have Settings
    // disagree with what the cloud lane actually holds. Only probe the
    // keyring when something is stored — see hasStoredCredentials.
    const usable = keys.length === 0 || isSafeStorageAvailable();
    const first = keys[0];
    return {
      hasPlatformKey: usable && keys.length > 0,
      platformKeyLabel: first?.label ?? null,
      platformOrgId: first?.orgId ?? null,
      platformOrgIds: usable ? keys.map((key) => key.orgId) : [],
      vaultLocked: !usable && keys.length > 0,
    };
  });
}
