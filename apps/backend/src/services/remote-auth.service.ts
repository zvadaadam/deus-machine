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

// ~250 short, memorable, unambiguous English words for two-word pairing codes.
// Avoids homophones, offensive words, and easily confused pairs.
const WORD_LIST = [
  "ABLE",
  "ACID",
  "AGED",
  "ALSO",
  "ARCH",
  "AREA",
  "ARMY",
  "AWAY",
  "BABY",
  "BACK",
  "BAND",
  "BANK",
  "BASE",
  "BATH",
  "BEAR",
  "BEAT",
  "BEEN",
  "BELL",
  "BELT",
  "BEST",
  "BIRD",
  "BLOW",
  "BLUE",
  "BOAT",
  "BODY",
  "BOLD",
  "BOLT",
  "BOMB",
  "BOND",
  "BONE",
  "BOOK",
  "BORN",
  "BOSS",
  "BOTH",
  "BOWL",
  "BULK",
  "BURN",
  "BUSH",
  "BUSY",
  "CAFE",
  "CAGE",
  "CAKE",
  "CALM",
  "CAME",
  "CAMP",
  "CAPE",
  "CARD",
  "CARE",
  "CASE",
  "CASH",
  "CAST",
  "CAVE",
  "CHIP",
  "CITY",
  "CLAN",
  "CLAY",
  "CLIP",
  "CLUB",
  "CLUE",
  "COAL",
  "COAT",
  "CODE",
  "COIN",
  "COLD",
  "COME",
  "COOK",
  "COOL",
  "COPE",
  "COPY",
  "CORD",
  "CORE",
  "CORK",
  "CORN",
  "COST",
  "CREW",
  "CROP",
  "CROW",
  "CUBE",
  "CURE",
  "CURL",
  "DARK",
  "DASH",
  "DATA",
  "DATE",
  "DAWN",
  "DEAL",
  "DEAR",
  "DECK",
  "DEEP",
  "DEER",
  "DEMO",
  "DENY",
  "DESK",
  "DIAL",
  "DIET",
  "DIRT",
  "DISC",
  "DISH",
  "DOCK",
  "DOME",
  "DONE",
  "DOOR",
  "DOSE",
  "DOWN",
  "DRAW",
  "DROP",
  "DRUM",
  "DUAL",
  "DUNE",
  "DUST",
  "DUTY",
  "EACH",
  "EARN",
  "EASE",
  "EAST",
  "EASY",
  "EDGE",
  "EDIT",
  "ELSE",
  "EPIC",
  "EVEN",
  "EVER",
  "EVIL",
  "EXAM",
  "FACE",
  "FACT",
  "FADE",
  "FAIL",
  "FAIR",
  "FAKE",
  "FALL",
  "FAME",
  "FARM",
  "FAST",
  "FATE",
  "FAWN",
  "FEED",
  "FEEL",
  "FELT",
  "FERN",
  "FILM",
  "FIND",
  "FINE",
  "FIRE",
  "FIRM",
  "FISH",
  "FLAG",
  "FLAT",
  "FLED",
  "FLIP",
  "FLOW",
  "FOAM",
  "FOLD",
  "FOLK",
  "FOND",
  "FONT",
  "FOOD",
  "FOOL",
  "FORD",
  "FORK",
  "FORM",
  "FORT",
  "FOUL",
  "FREE",
  "FROM",
  "FUEL",
  "FULL",
  "FUND",
  "FURY",
  "FUSE",
  "GAIN",
  "GALE",
  "GAME",
  "GANG",
  "GATE",
  "GAVE",
  "GEAR",
  "GIFT",
  "GIRL",
  "GLAD",
  "GLOW",
  "GLUE",
  "GOAT",
  "GOLD",
  "GOLF",
  "GONE",
  "GOOD",
  "GRAB",
  "GRAY",
  "GREW",
  "GRID",
  "GRIP",
  "GROW",
  "GULF",
  "GURU",
  "GUST",
  "HACK",
  "HAIL",
  "HALF",
  "HALL",
  "HALT",
  "HAND",
  "HANG",
  "HARD",
  "HARM",
  "HARP",
  "HATE",
  "HAUL",
  "HAWK",
  "HAZE",
  "HEAD",
  "HEAL",
  "HEAP",
  "HEAT",
  "HELD",
  "HELM",
  "HELP",
  "HERB",
  "HERO",
  "HIGH",
  "HIKE",
  "HILL",
  "HINT",
  "HIRE",
  "HIVE",
  "HOLD",
  "HOLE",
  "HOME",
  "HOOD",
  "HOOK",
  "HOPE",
  "HORN",
  "HOST",
  "HUGE",
  "HULL",
  "HUNG",
  "HUNT",
  "HURT",
  "ICON",
  "IDEA",
  "INCH",
  "INTO",
  "IRON",
  "ISLE",
  "ITEM",
  "JACK",
  "JADE",
  "JAIL",
  "JAVA",
  "JAZZ",
  "JEAN",
  "JEST",
  "JOBS",
  "JOIN",
  "JOKE",
  "JUMP",
  "JUNE",
  "JURY",
  "JUST",
  "KEEN",
  "KEEP",
  "KELP",
  "KEPT",
  "KICK",
  "KIND",
  "KING",
  "KITE",
  "KNOT",
  "KNOW",
  "LACE",
  "LACK",
  "LAID",
  "LAKE",
  "LAMB",
  "LAMP",
  "LAND",
  "LANE",
  "LARK",
  "LAST",
  "LATE",
  "LAWN",
  "LEAD",
  "LEAF",
  "LEAN",
  "LEAP",
  "LEFT",
  "LEND",
  "LENS",
  "LESS",
  "LIFE",
  "LIFT",
  "LIME",
  "LINE",
  "LINK",
  "LION",
  "LIST",
  "LIVE",
  "LOAD",
  "LOAN",
  "LOCK",
  "LOGO",
  "LONG",
  "LOOK",
  "LORD",
  "LOSE",
  "LOST",
  "LOUD",
  "LOVE",
  "LUCK",
  "LUMP",
  "LUNG",
  "LURE",
  "LURK",
];

// ---- In-memory state ----

const activeCodes = new Map<string, PairingCode>();
const rateLimits = new Map<string, RateLimitEntry>();

// ---- Pairing Codes ----

/** Generate a two-word pairing code (e.g. "SOFT TIGER"). Returns the code string and its expiry. */
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

  // Pick two different words
  const idx1 = randomInt(WORD_LIST.length);
  let idx2 = randomInt(WORD_LIST.length - 1);
  if (idx2 >= idx1) idx2 += 1;

  const code = `${WORD_LIST[idx1]} ${WORD_LIST[idx2]}`;
  const expiresAt = now + CODE_TTL_MS;

  activeCodes.set(code, { code, createdAt: now, expiresAt });
  return { code, expiresAt };
}

/**
 * Normalize a pairing code input to canonical form (e.g. "SOFT TIGER").
 * Accepts dashes, underscores, plus signs, and extra whitespace as word separators.
 */
function normalizePairCode(raw: string): string {
  return raw
    .trim()
    .replace(/[-_+]/g, " ") // treat dashes, underscores, plus as spaces
    .replace(/\s+/g, " ") // collapse multiple spaces
    .toUpperCase();
}

/** Validate a pairing code. Reusable within its TTL — multiple devices can pair with the same code. */
export function validatePairCode(code: string): boolean {
  const normalized = normalizePairCode(code);
  const entry = activeCodes.get(normalized);
  if (!entry) {
    console.log(`[Auth] Code "${normalized}" not found. Active codes: ${activeCodes.size}`);
    return false;
  }
  if (entry.expiresAt <= Date.now()) {
    activeCodes.delete(normalized);
    return false;
  }
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
  userAgent: string | null
): { token: string; device: PairedDevice } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const id = generateId();

  const db = getDatabase();
  db.prepare(
    `
    INSERT INTO paired_devices (id, name, token_hash, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(id, name || "Unknown Device", tokenHash, ip, userAgent);

  const device = db.prepare("SELECT * FROM paired_devices WHERE id = ?").get(id) as PairedDevice;
  return { token, device };
}

/** Validate a raw Bearer token. Returns the device if valid, null otherwise. */
export function validateDeviceToken(token: string): PairedDevice | null {
  const tokenHash = hashToken(token);
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM paired_devices WHERE token_hash = ?")
      .get(tokenHash) as PairedDevice) ?? null
  );
}

/** Update last_seen_at for a device by token hash. */
export function updateLastSeen(tokenHash: string): void {
  const db = getDatabase();
  db.prepare("UPDATE paired_devices SET last_seen_at = datetime('now') WHERE token_hash = ?").run(
    tokenHash
  );
}

/** List all paired devices (token_hash excluded from the returned objects for safety). */
export function listDevices(): Omit<PairedDevice, "token_hash">[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT id, name, ip_address, user_agent, last_seen_at, created_at FROM paired_devices ORDER BY created_at DESC"
    )
    .all() as Omit<PairedDevice, "token_hash">[];
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
