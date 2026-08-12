/**
 * Browser import service (macOS).
 *
 * Enumerates local Chromium-based browser profiles and extracts their cookies
 * so the agent's in-app browser can reuse sessions the user is already logged
 * into. This mirrors what "Energy" does: read the profile list from each
 * browser's `Local State`, then decrypt the cookie DB with the AES key stored
 * in the macOS Keychain ("<Browser> Safe Storage").
 *
 * Read-only: we never write to the source browser's files. Decrypted cookies
 * are handed back to the caller, which forwards them to the desktop main
 * process for injection into the `persist:browser` <webview> session.
 *
 * Scope: macOS + Chromium engines only (Chrome/Brave/Edge/Arc). Safari is
 * intentionally excluded — its cookie container is TCC-protected and uses a
 * bespoke binary format.
 */

import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import fs from "node:fs";
import { openSqliteDatabase } from "../lib/sqlite";
import type { BrowserId, BrowserProfile, ImportCookie } from "@shared/types/browser-import";

export type { BrowserId, BrowserProfile, ImportCookie };

const execFileAsync = promisify(execFile);

interface BrowserDef {
  id: BrowserId;
  name: string;
  /** Path under ~/Library/Application Support */
  base: string;
  /** macOS Keychain generic-password service holding the AES key. */
  keychainService: string;
}

const BROWSERS: BrowserDef[] = [
  { id: "chrome", name: "Chrome", base: "Google/Chrome", keychainService: "Chrome Safe Storage" },
  {
    id: "brave",
    name: "Brave",
    base: "BraveSoftware/Brave-Browser",
    keychainService: "Brave Safe Storage",
  },
  { id: "edge", name: "Edge", base: "Microsoft Edge", keychainService: "Microsoft Edge Safe Storage" },
  { id: "arc", name: "Arc", base: "Arc/User Data", keychainService: "Arc Safe Storage" },
];

/** info_cache keys that are not real user profiles. */
const SKIP_PROFILE_DIRS = new Set(["System Profile", "Guest Profile"]);

function appSupportDir(): string {
  return join(homedir(), "Library", "Application Support");
}

function isMac(): boolean {
  return process.platform === "darwin";
}

// ---------------------------------------------------------------------------
// Profile enumeration
// ---------------------------------------------------------------------------

interface InfoCacheEntry {
  name?: string;
  user_name?: string;
}

/** Read one browser's profiles from its Local State `profile.info_cache`. */
function enumerateBrowser(def: BrowserDef): BrowserProfile[] {
  const localStatePath = join(appSupportDir(), def.base, "Local State");
  let raw: string;
  try {
    raw = fs.readFileSync(localStatePath, "utf8");
  } catch {
    return []; // browser not installed / never launched
  }

  let infoCache: Record<string, InfoCacheEntry>;
  try {
    infoCache = JSON.parse(raw)?.profile?.info_cache ?? {};
  } catch {
    return [];
  }

  const profiles: BrowserProfile[] = [];
  for (const [profileDir, meta] of Object.entries(infoCache)) {
    if (SKIP_PROFILE_DIRS.has(profileDir)) continue;

    let lastActiveMs: number | null = null;
    try {
      lastActiveMs = fs.statSync(join(appSupportDir(), def.base, profileDir)).mtimeMs;
    } catch {
      // profile dir missing — still list it, just without a timestamp
    }

    profiles.push({
      browserId: def.id,
      browserName: def.name,
      profileDir,
      name: meta.name ?? null,
      email: meta.user_name ?? null,
      lastActiveMs,
    });
  }
  return profiles;
}

/** List all Chromium profiles across supported browsers, most-recent first. */
export function listBrowserProfiles(): BrowserProfile[] {
  if (!isMac()) return [];
  return BROWSERS.flatMap(enumerateBrowser).sort(
    (a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Cookie extraction + decryption
// ---------------------------------------------------------------------------

/**
 * Fetch the AES key from the macOS Keychain. This triggers the OS "allow
 * access" prompt the first time (per browser) — that prompt IS the user's
 * consent. Requires a codesigned build to be remembered across launches.
 */
async function getAesKey(def: BrowserDef): Promise<Buffer> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-w",
    "-s",
    def.keychainService,
  ]);
  const password = stdout.trim();
  if (!password) throw new Error(`Empty Keychain password for "${def.keychainService}"`);
  // Chromium's fixed macOS KDF params.
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** True when the first bytes look like printable ASCII text. */
function looksPrintable(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0x09) continue; // tab
    if (b < 0x20 || b > 0x7e) return false;
  }
  return n > 0;
}

/**
 * Decrypt a Chromium `encrypted_value` blob (macOS v10/v11 scheme):
 * AES-128-CBC, IV = 16 spaces, PKCS#7 padding. Chrome 130+ additionally
 * prepends a 32-byte SHA-256 domain hash to the plaintext; we detect and
 * strip it heuristically (the hash is binary, real values start printable).
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length < 3) return null;
  const version = encrypted.subarray(0, 3).toString("latin1");
  if (version !== "v10" && version !== "v11") return null;

  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);

  let out: Buffer;
  try {
    out = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }

  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16 || pad > out.length) return null;
  let plain = out.subarray(0, out.length - pad);

  if (plain.length >= 32 && !looksPrintable(plain)) {
    plain = plain.subarray(32);
  }
  return plain.toString("utf8");
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer | Uint8Array | null;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

/** Copy the cookie DB (+WAL/SHM) to a temp dir so a running browser can't lock us out. */
function copyDbToTemp(dbPath: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "deus-cookies-"));
  const dest = join(dir, "Cookies");
  fs.copyFileSync(dbPath, dest);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, dest + ext);
  }
  return dest;
}

/** Resolve the cookie DB path (Chrome 96+ moved it under Network/). */
function cookieDbPath(def: BrowserDef, profileDir: string): string | null {
  const profileRoot = join(appSupportDir(), def.base, profileDir);
  const candidates = [join(profileRoot, "Network", "Cookies"), join(profileRoot, "Cookies")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function mapSameSite(v: number): ImportCookie["sameSite"] {
  switch (v) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

// Chromium timestamps are microseconds since 1601-01-01.
const CHROMIUM_EPOCH_OFFSET_SEC = 11644473600;

/**
 * Read and decrypt all cookies for one profile.
 * Returns cookies shaped for Electron's `session.cookies.set`.
 */
export async function readProfileCookies(
  browserId: BrowserId,
  profileDir: string
): Promise<ImportCookie[]> {
  if (!isMac()) return [];
  const def = BROWSERS.find((b) => b.id === browserId);
  if (!def) throw new Error(`Unknown browser: ${browserId}`);

  // profileDir is caller-supplied and flows into a filesystem path, so it must
  // never be trusted directly. Accept only a directory this browser actually
  // reports — that both validates input and blocks path traversal.
  if (!enumerateBrowser(def).some((p) => p.profileDir === profileDir)) {
    throw new Error(`Unknown profile: ${profileDir}`);
  }

  const dbPath = cookieDbPath(def, profileDir);
  if (!dbPath) return [];

  const key = await getAesKey(def);

  let db: ReturnType<typeof openSqliteDatabase>;
  let tempPath: string | null = null;
  try {
    db = openSqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    tempPath = copyDbToTemp(dbPath);
    db = openSqliteDatabase(tempPath, { readonly: true, fileMustExist: true });
  }

  let rows: CookieRow[];
  try {
    rows = db.prepare(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies"
    ).all() as CookieRow[];
  } finally {
    db.close();
    if (tempPath) fs.rmSync(dirname(tempPath), { recursive: true, force: true });
  }

  const cookies: ImportCookie[] = [];
  for (const row of rows) {
    let value = row.value ?? "";
    if ((!value || value.length === 0) && row.encrypted_value && row.encrypted_value.length > 0) {
      const decrypted = decryptCookieValue(Buffer.from(row.encrypted_value), key);
      if (decrypted === null) continue; // undecryptable — skip rather than corrupt the session
      value = decrypted;
    }

    const secure = row.is_secure === 1;
    const host = row.host_key.replace(/^\./, "");
    if (!host) continue;

    cookies.push({
      url: `${secure ? "https" : "http"}://${host}${row.path || "/"}`,
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path || "/",
      secure,
      httpOnly: row.is_httponly === 1,
      expirationDate:
        row.expires_utc && row.expires_utc > 0
          ? row.expires_utc / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SEC
          : undefined,
      sameSite: mapSameSite(row.samesite),
    });
  }
  return cookies;
}
