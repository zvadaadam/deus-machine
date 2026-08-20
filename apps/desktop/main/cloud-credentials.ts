// Durable home for cloud credentials on this device: the per-device agnt
// platform key (minted after Deus Cloud sign-in) and the Claude subscription
// token (Settings → Agents). Built on the shared safeStorage-file primitive;
// the renderer never sees values — only presence/meta. The backend receives
// them at spawn (env) and at runtime (local credentials route).

import {
  decryptSecret,
  encryptSecret,
  readJsonFile,
  removeFile,
  userDataFilePath,
  writeJsonFile,
} from "./safe-storage-file";

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
