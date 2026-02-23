import fs from 'fs';
import path from 'path';
import { DB_PATH } from '../lib/database';
import { PreferencesFile } from '../lib/schemas';

// Co-locate with hive.db in the Tauri app data directory.
// Derived from DB_PATH so tests that set DATABASE_PATH get sandboxing for free.
const PREFS_PATH = path.join(path.dirname(DB_PATH), 'preferences.json');

function readPreferences(): Record<string, any> {
  if (!fs.existsSync(PREFS_PATH)) {
    return {};
  }

  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
    const parsed = PreferencesFile.safeParse(raw);
    if (!parsed.success) {
      console.error('[settings] Invalid preferences.json, returning raw:', parsed.error.issues);
      return raw;
    }
    return parsed.data;
  } catch (error) {
    console.error('[settings] Error reading preferences.json:', error);
    return {};
  }
}

function writePreferences(settings: Record<string, any>): void {
  const dir = path.dirname(PREFS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = PREFS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, PREFS_PATH);
}

export function getAllSettings(): Record<string, any> {
  return readPreferences();
}

/** Get a single setting value by key. Returns the parsed value or null. */
export function getSetting(key: string): any {
  const prefs = readPreferences();
  return key in prefs ? prefs[key] : null;
}

export function saveSetting(key: string, value: any): void {
  const current = readPreferences();
  // Guard against readPreferences returning a non-object (e.g. if Zod fails and raw is an array/string)
  const obj = (typeof current === 'object' && current !== null && !Array.isArray(current))
    ? current
    : {};
  obj[key] = value;
  writePreferences(obj);
}

export { PREFS_PATH };
