import fs from "fs";
import path from "path";
import { DB_PATH } from "../lib/database";
import { PreferencesFile } from "../lib/schemas";

// Co-locate with deus.db in the Electron app data directory.
// Derived from DB_PATH so tests that set DATABASE_PATH get sandboxing for free.
const PREFS_PATH = path.join(path.dirname(DB_PATH), "preferences.json");

function readPreferences(): Record<string, any> {
  if (!fs.existsSync(PREFS_PATH)) {
    return {};
  }

  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    const parsed = PreferencesFile.safeParse(raw);
    if (!parsed.success) {
      console.error("[settings] Invalid preferences.json, returning raw:", parsed.error.issues);
      return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
    }
    return parsed.data;
  } catch (error) {
    console.error("[settings] Error reading preferences.json:", error);
    return {};
  }
}

function writePreferences(settings: Record<string, any>): void {
  const dir = path.dirname(PREFS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = PREFS_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, PREFS_PATH);
}

/**
 * Kept in preferences.json but never served or written through the settings
 * API: remote devices read settings through the relay. `relay_machines` holds
 * this computer's Deus Cloud machine secrets.
 */
export const PRIVATE_SETTINGS: ReadonlySet<string> = new Set(["relay_machines"]);

/** Delete settings outright (not set them to null). Returns whether any existed. */
export function removeSettings(keys: readonly string[]): boolean {
  const prefs = readPreferences();
  const present = keys.filter((key) => key in prefs);
  if (present.length === 0) return false;
  for (const key of present) delete prefs[key];
  writePreferences(prefs);
  return true;
}

export function getAllSettings(): Record<string, any> {
  const prefs = readPreferences();
  for (const key of PRIVATE_SETTINGS) delete prefs[key];
  return prefs;
}

/** Get a single setting value by key. Returns the parsed value or null. */
export function getSetting(key: string): any {
  const prefs = readPreferences();
  return key in prefs ? prefs[key] : null;
}

export function saveSetting(key: string, value: any): void {
  const current = readPreferences();
  // Guard against readPreferences returning a non-object (e.g. if Zod fails and raw is an array/string)
  const obj =
    typeof current === "object" && current !== null && !Array.isArray(current) ? current : {};
  obj[key] = value;
  writePreferences(obj);
}

export { PREFS_PATH };
