import { linkSync, lstatSync, unlinkSync } from "node:fs";
import { basename, join, parse } from "node:path";
import { app } from "electron";
import { PRELAUNCH_SCHEMA_MISMATCH } from "../../../shared/schema";
import { logMainProcess } from "./startup-diagnostics";

// Release the live database name last, after all its side files are out of the way.
const suffixes = ["-wal", "-shm", "-journal", ""];
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

export class OutdatedDatabaseError extends Error {
  constructor(readonly databasePath: string) {
    super(PRELAUNCH_SCHEMA_MISMATCH);
  }
}

const devRestartHint =
  "Run 'bun run dev' again to open Deus with no projects, workspaces, or chats.";

export function databaseRecoveryMessage(backup: string, devRendererUrl?: string) {
  const next = devRendererUrl
    ? `and quits Deus. ${devRestartHint}`
    : "and reopens Deus with no projects, workspaces, or chats.";
  return {
    message: "Deus can't read your saved data",
    detail: `An older version saved this data. Start Fresh keeps it in ${basename(backup)} ${next}`,
    buttons: ["Show Logs", "Quit", "Start Fresh"],
  };
}

export function startFresh(database: string, backup: string, devRendererUrl?: string): void {
  moveDatabaseAside(database, backup);
  if (devRendererUrl) {
    // electron-vite stops its renderer server when Electron quits.
    logMainProcess(`[main] Saved the database to ${backup}. ${devRestartHint}`);
    return;
  }
  const image = process.platform === "linux" && process.env.APPIMAGE;
  app.relaunch(image ? { execPath: image } : {});
}

export function datedBackupPath(databasePath: string): string {
  const { dir, name, ext } = parse(databasePath);
  const stem = join(dir, `${name}-${new Date().toISOString().slice(0, 10)}`);
  let backup = stem + ext;
  try {
    for (let n = 2; suffixes.some((suffix) => exists(backup + suffix)); n++) {
      backup = `${stem}-${n}${ext}`;
    }
  } catch {
    // The move rechecks every name and reports filesystem errors if Start Fresh is chosen.
  }
  return backup;
}

export function moveDatabaseAside(database: string, backup: string): void {
  if (suffixes.some((s) => exists(backup + s))) throw new Error(`Backup already exists: ${backup}`);
  const linked: string[] = [];
  const moved: string[] = [];
  try {
    // link refuses an occupied name. Give every file its backup name before releasing any old name.
    for (const s of suffixes) {
      if (s && !exists(database + s)) continue;
      linkSync(database + s, backup + s);
      linked.push(s);
    }
    for (const s of linked) {
      unlinkSync(database + s);
      moved.push(s);
    }
  } catch (error) {
    for (const s of moved) linkSync(backup + s, database + s);
    for (const s of linked) unlinkSync(backup + s);
    throw error;
  }
}
