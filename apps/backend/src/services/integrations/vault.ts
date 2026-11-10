// backend/src/services/integrations/vault.ts
// Seals integration credentials (OAuth tokens, registered clients, pasted
// keys) before they reach the database: AES-256-GCM with a per-computer key.
//
// The key lives in the macOS Keychain when there is one, else in a 0600 file
// beside deus.db. `DEUS_VAULT_KEY` (64 hex chars) overrides both — tests and
// headless hosts. What this buys: a copied or backed-up deus.db opens
// nothing. What it does not: another program running as the same user can
// ask the Keychain the way this one does.
//
// A credential sealed under a key that is gone opens as null, and its
// connection asks the user to connect again: losing the key loses sign-ins,
// never the app.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { DB_PATH } from "../../lib/database";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "Deus Integrations";
const KEYCHAIN_ACCOUNT = "vault-key";
const VERSION = "v1";

let cachedKey: Buffer | null = null;

function fromHex(value: string | undefined): Buffer | null {
  if (!value || !/^[0-9a-f]{64}$/i.test(value.trim())) return null;
  return Buffer.from(value.trim(), "hex");
}

function usesKeychain(): boolean {
  return process.platform === "darwin" && process.env.DEUS_VAULT_NO_KEYCHAIN !== "1";
}

function keyFilePath(): string {
  return path.join(path.dirname(DB_PATH), "integrations.key");
}

function readKeyFile(): Buffer | null {
  try {
    return fromHex(fs.readFileSync(keyFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function createKeyFile(): Buffer {
  const created = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(keyFilePath()), { recursive: true });
  // `wx`: never over a key another process wrote first; read theirs instead.
  try {
    fs.writeFileSync(keyFilePath(), created, { mode: 0o600, flag: "wx" });
    return Buffer.from(created, "hex");
  } catch {
    const theirs = readKeyFile();
    if (theirs) return theirs;
    throw new Error(`The vault key file at ${keyFilePath()} is unreadable`);
  }
}

type KeychainAnswer = { status: "found"; key: Buffer } | { status: "missing" | "unavailable" };

/** `security` exits 44 when there is no such item; anything else is the Keychain not answering. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

async function keychainRead(): Promise<KeychainAnswer> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", timeout: 5_000 }
    );
    const key = fromHex(stdout);
    // An item that is not a key is someone else's: leave it, do not replace it.
    return key ? { status: "found", key } : { status: "unavailable" };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { status: code === KEYCHAIN_ITEM_NOT_FOUND ? "missing" : "unavailable" };
  }
}

/**
 * Store a new key through `security -i`: on its stdin, never in a process's
 * arguments. No `-U`: an item that exists is never overwritten.
 */
function keychainCreate(hex: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once("error", () => resolve(false));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.end(
      `add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w ${hex}\n`
    );
  });
}

/** The Keychain holds the key but is not answering (locked, slow): nothing can be sealed or opened. */
let unavailable = false;

/** Whether the vault can seal and open right now. */
export function vaultAvailable(): boolean {
  return !unavailable;
}

/**
 * Find or create the key, off the event loop's critical path: called once at
 * startup, so sealing and opening never wait on the Keychain. A key is
 * created only where there provably is none: a Keychain that does not answer
 * leaves the vault unavailable for this run rather than minting a second key
 * over sign-ins sealed under the first. Safe to call again.
 */
export async function initVault(): Promise<void> {
  if (cachedKey) return;
  unavailable = false;
  const fromEnv = fromHex(process.env.DEUS_VAULT_KEY);
  if (fromEnv) {
    cachedKey = fromEnv;
    return;
  }
  // A key file already in use wins: credentials are sealed under it.
  const existing = readKeyFile();
  if (existing) {
    cachedKey = existing;
    return;
  }
  if (!usesKeychain()) {
    cachedKey ??= createKeyFile();
    return;
  }
  let answer = await keychainRead();
  if (answer.status === "missing") {
    // Created without overwrite, then read back: another Deus process may have won.
    await keychainCreate(crypto.randomBytes(32).toString("hex"));
    answer = await keychainRead();
  }
  if (answer.status === "found") {
    cachedKey ??= answer.key;
    return;
  }
  unavailable = true;
  console.warn("[Integrations] The Keychain did not answer; app sign-ins are unavailable for now");
}

function vaultKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (unavailable) throw new Error("The Keychain is locked; unlock it and restart Deus");
  // Before `initVault` has run (a test, a script): the environment, else the file.
  cachedKey = fromHex(process.env.DEUS_VAULT_KEY) ?? readKeyFile() ?? createKeyFile();
  return cachedKey;
}

/** Seal a JSON value: `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function seal(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body].map(encodePart).join(".");
}

/** Open a sealed value; null when it was sealed under another key or is damaged. */
export function open<T>(sealed: string | null | undefined): T | null {
  if (!sealed) return null;
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      vaultKey(),
      Buffer.from(iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}

function encodePart(part: string | Buffer): string {
  return typeof part === "string" ? part : part.toString("base64url");
}

/** @internal Tests swap keys between cases. */
export function __resetVaultKeyForTests(): void {
  cachedKey = null;
  unavailable = false;
}
