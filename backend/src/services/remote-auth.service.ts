// backend/src/services/remote-auth.service.ts
// Core auth logic for remote access: pairing codes, device tokens, rate limiting.
// Pairing codes are ephemeral (in-memory), device tokens are persistent (DB).

import { randomBytes, randomInt, createHash } from "crypto";
import { getDatabase } from "../lib/database";
import { getSetting, saveSetting } from "./settings.service";

// ---- Types ----

export interface PairedDevice {
  id: string;
  name: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  last_seen_at: string;
  created_at: string;
}

interface PairingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
}

interface RateLimitEntry {
  failures: number;
  lockedUntil: number;
}

// ---- Constants ----

const MAX_ACTIVE_CODES = 5;
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_FAILURES = 10;
const RATE_LIMIT_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

// 100 short, memorable words for pairing codes
const WORD_LIST = [
  "ALPHA", "BEAR", "BOLT", "BRAVE", "BYTE",
  "CEDAR", "CLOUD", "CORAL", "CRANE", "CROWN",
  "DAWN", "DELTA", "DRIFT", "DUNE", "EAGLE",
  "EMBER", "FERN", "FLAME", "FLASH", "FLINT",
  "FORGE", "FROST", "GLOW", "GROVE", "HAWK",
  "HAVEN", "HAZE", "HELM", "HIVE", "IRON",
  "JADE", "KEEN", "LAKE", "LARK", "LEAF",
  "LIGHT", "LIME", "LINK", "LUNA", "LYNX",
  "MAPLE", "MARS", "MESA", "MINT", "MIST",
  "MOSS", "NIGHT", "NODE", "NOVA", "OAK",
  "OPAL", "ORBIT", "PALM", "PEAK", "PINE",
  "PIXEL", "PLUM", "POLAR", "PULSE", "QUARTZ",
  "RAIN", "RAPID", "REEF", "RIDGE", "RIVER",
  "ROBIN", "RUNE", "RUSH", "SAGE", "SHELL",
  "SILK", "SKY", "SLATE", "SOLAR", "SPARK",
  "SPIRE", "STEEL", "STONE", "STORM", "SWIFT",
  "THORN", "TIDE", "TIGER", "TRAIL", "TREE",
  "VALE", "VAPOR", "VINE", "VIPER", "WAVE",
  "WHALE", "WIND", "WING", "WOLF", "WREN",
  "YACHT", "YARN", "ZENITH", "ZINC", "ZONE",
];

// ---- In-memory state ----

const activeCodes = new Map<string, PairingCode>();
const rateLimits = new Map<string, RateLimitEntry>();

// ---- Pairing Codes ----

/** Generate a WORD-NNNN pairing code. Returns the code string and its expiry. */
export function generatePairCode(): { code: string; expiresAt: number } {
  // Evict expired codes first
  const now = Date.now();
  for (const [key, entry] of activeCodes) {
    if (entry.expiresAt <= now) activeCodes.delete(key);
  }

  // Enforce max active codes
  if (activeCodes.size >= MAX_ACTIVE_CODES) {
    // Evict oldest
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of activeCodes) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) activeCodes.delete(oldestKey);
  }

  const word = WORD_LIST[randomInt(WORD_LIST.length)];
  const number = String(randomInt(1000, 10000)); // 1000-9999
  const code = `${word}-${number}`;
  const expiresAt = now + CODE_TTL_MS;

  activeCodes.set(code, { code, createdAt: now, expiresAt });
  return { code, expiresAt };
}

/** Validate and consume a pairing code. Returns true if valid (one-time use). */
export function validatePairCode(code: string): boolean {
  const upper = code.toUpperCase().trim();
  const entry = activeCodes.get(upper);
  if (!entry) {
    console.log(`[Auth] Code "${upper}" not found. Active codes: ${activeCodes.size} (keys: ${[...activeCodes.keys()].join(", ") || "none"})`);
    return false;
  }
  if (entry.expiresAt <= Date.now()) {
    activeCodes.delete(upper);
    return false;
  }
  // One-time use — delete immediately
  activeCodes.delete(upper);
  return true;
}

/** Get number of active (non-expired) pairing codes. */
export function getActiveCodeCount(): number {
  const now = Date.now();
  for (const [key, entry] of activeCodes) {
    if (entry.expiresAt <= now) activeCodes.delete(key);
  }
  return activeCodes.size;
}

// ---- Device Tokens ----

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateId(): string {
  return randomBytes(16).toString("hex");
}

/** Create a new device token. Returns the raw token (only shown once) and device record. */
export function createDeviceToken(
  name: string,
  ip: string | null,
  userAgent: string | null,
): { token: string; device: PairedDevice } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const id = generateId();

  const db = getDatabase();
  db.prepare(`
    INSERT INTO paired_devices (id, name, token_hash, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name || "Unknown Device", tokenHash, ip, userAgent);

  const device = db.prepare("SELECT * FROM paired_devices WHERE id = ?").get(id) as PairedDevice;
  return { token, device };
}

/** Validate a raw Bearer token. Returns the device if valid, null otherwise. */
export function validateDeviceToken(token: string): PairedDevice | null {
  const tokenHash = hashToken(token);
  const db = getDatabase();
  return (db.prepare("SELECT * FROM paired_devices WHERE token_hash = ?").get(tokenHash) as PairedDevice) ?? null;
}

/** Update last_seen_at for a device by token hash. */
export function updateLastSeen(tokenHash: string): void {
  const db = getDatabase();
  db.prepare("UPDATE paired_devices SET last_seen_at = datetime('now') WHERE token_hash = ?").run(tokenHash);
}

/** List all paired devices (token_hash excluded from the returned objects for safety). */
export function listDevices(): Omit<PairedDevice, "token_hash">[] {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT id, name, ip_address, user_agent, last_seen_at, created_at FROM paired_devices ORDER BY created_at DESC",
  ).all() as Omit<PairedDevice, "token_hash">[];
  return rows;
}

/** Revoke (delete) a paired device by id. Returns true if a row was deleted. */
export function revokeDevice(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM paired_devices WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---- Rate Limiting (per IP) ----

/** Check if an IP is rate-limited. Returns lockout remaining ms or 0. */
export function checkRateLimit(ip: string): number {
  const entry = rateLimits.get(ip);
  if (!entry) return 0;
  const now = Date.now();
  if (entry.lockedUntil > now) return entry.lockedUntil - now;
  return 0;
}

/** Record a failed pairing attempt for an IP. */
export function recordFailure(ip: string): void {
  const entry = rateLimits.get(ip) ?? { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= RATE_LIMIT_FAILURES) {
    entry.lockedUntil = Date.now() + RATE_LIMIT_LOCKOUT_MS;
  }
  rateLimits.set(ip, entry);
}

/** Reset rate limit for an IP (called on successful pairing). */
export function resetRateLimit(ip: string): void {
  rateLimits.delete(ip);
}

// ---- Relay Credentials ----

/** Generate relay credentials (server_id + relay_token). Stores in preferences.json. */
export function generateRelayCredentials(): { serverId: string; relayToken: string } {
  const serverId = randomBytes(4).toString("hex"); // 8-char hex
  const relayToken = randomBytes(32).toString("hex");
  saveSetting("relay_server_id", serverId);
  saveSetting("relay_token", relayToken);
  return { serverId, relayToken };
}

/** Get stored relay credentials, or null if not yet generated. */
export function getRelayCredentials(): { serverId: string; relayToken: string } | null {
  const serverId = getSetting("relay_server_id");
  const relayToken = getSetting("relay_token");
  if (!serverId || !relayToken) return null;
  return { serverId, relayToken };
}

// ---- Test Helpers (exported for testing only) ----

export function _clearAll(): void {
  activeCodes.clear();
  rateLimits.clear();
}
