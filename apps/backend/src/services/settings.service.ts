import { isPublicSetting, type Settings } from "@shared/types/settings";
import fs from "fs";
import path from "path";
import { DB_PATH } from "../lib/database";
import { PreferencesFile } from "../lib/schemas";
import { invalidate } from "./query-engine";

function preferencesPath(): string {
  return path.join(path.dirname(DB_PATH), "preferences.json");
}

// Read from disk once; every write below clears it. Callers get their own copy.
let cached: Record<string, any> | null = null;

function readPreferences(): Record<string, any> {
  cached ??= loadPreferences();
  return structuredClone(cached);
}

function loadPreferences(): Record<string, any> {
  const file = preferencesPath();
  if (!fs.existsSync(file)) {
    return {};
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
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
  const file = preferencesPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = file + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, file);
  cached = null;
}

export function getAllSettings(): Settings {
  return Object.fromEntries(
    Object.entries(readPreferences()).filter(([key]) => isPublicSetting(key))
  );
}

/** Get a single setting value by key. Returns the parsed value or null. */
export function getSetting(key: string): any {
  const prefs = readPreferences();
  return key in prefs ? prefs[key] : null;
}

export function saveSetting(key: string, value: any): void {
  const current = readPreferences();
  current[key] = value;
  writePreferences(current);
  if (isPublicSetting(key))
    invalidate(key === "server_name" ? ["settings", "relayStatus"] : ["settings"]);
}
