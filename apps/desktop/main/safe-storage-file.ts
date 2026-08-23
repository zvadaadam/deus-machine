// The one safeStorage-backed file primitive: OS-encrypted string values
// inside 0600 JSON files under userData. Both credential homes (the WorkOS
// session file and the cloud credential vault) build on this — one place
// owns the encrypt/decrypt/permission rules.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

export function userDataFilePath(fileName: string): string {
  return join(app.getPath("userData"), fileName);
}

/** Whether the OS keyring can encrypt right now — transient on Linux. */
export function isSafeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function requireSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this device");
  }
}

export function encryptSecret(value: string): string {
  requireSafeStorage();
  return safeStorage.encryptString(value).toString("base64");
}

/** Throws when the stored bytes no longer decrypt (OS keychain reset). */
export function decryptSecret(encrypted: string): string {
  requireSafeStorage();
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

/** Parse a JSON file; null when missing or unparseable. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write a JSON file owner-read/write only, creating parent dirs. */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // Temp + rename: writeFile truncates in place, so a crash mid-write left a
  // torn file that readJsonFile's catch turned into an empty store — i.e. a
  // power cut during any vault write silently wiped every credential.
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, filePath);
}

export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
