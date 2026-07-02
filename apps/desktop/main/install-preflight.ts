import { app, dialog } from "electron";
import { realpathSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { logMainProcess } from "./startup-diagnostics";

function canonicalPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolve(filePath);
  }
}

function isInsideDirectory(filePath: string, directoryPath: string): boolean {
  const normalizedFile = canonicalPath(filePath);
  const normalizedDirectory = canonicalPath(directoryPath);
  const relativePath = relative(normalizedDirectory, normalizedFile);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function isApplicationsInstallPath(executablePath: string, homeDir: string): boolean {
  return (
    isInsideDirectory(executablePath, "/Applications") ||
    isInsideDirectory(executablePath, join(homeDir, "Applications"))
  );
}

function getHomeDirectoryCandidates(): string[] {
  return [app.getPath("home"), process.env.HOME].filter(
    (value, index, values): value is string =>
      typeof value === "string" && value.length > 0 && values.indexOf(value) === index
  );
}

function buildManualMoveDetail(executablePath: string, failureReason?: string): string {
  return [
    "Deus could not install itself into Applications automatically.",
    "",
    "Launching directly from a disk image, Downloads, or another transient location can cause macOS to randomize the app path and break bundled backend processes.",
    "",
    `Current location: ${executablePath}`,
    failureReason ? "" : null,
    failureReason ?? null,
    "",
    "Drag Deus into Applications manually, then reopen it from there.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function quitWithManualMoveGuidance(
  executablePath: string,
  failureReason?: string
): Promise<void> {
  await dialog.showMessageBox({
    type: "error",
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Move Deus to Applications manually",
    detail: buildManualMoveDetail(executablePath, failureReason),
  });
  app.quit();
}

/**
 * First-launch installer. When the packaged app is opened from a disk image,
 * Downloads, or any other non-Applications location, it silently installs
 * itself into /Applications and relaunches from there — double-clicking the
 * app in the DMG is enough, no drag-to-Applications step (same flow as the
 * Codex and Claude desktop apps).
 *
 * Electron's bundle mover handles the mechanics: it trashes a stale existing
 * copy, escalates to an authorized install when /Applications is not
 * writable, strips the quarantine attribute, relaunches the installed copy,
 * and detaches the source disk image. If a copy is already running from
 * Applications it hands focus to that copy instead of replacing it (the
 * single-instance lock normally exits us before that can even happen).
 *
 * Returns true when startup must stop — the app is relaunching from
 * Applications, handing off to a running copy, or quitting after a failed
 * move.
 */
export async function ensureInstalledInApplications(): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return false;
  }

  const executablePath = app.getPath("exe");
  if (
    getHomeDirectoryCandidates().some((homeDir) =>
      isApplicationsInstallPath(executablePath, homeDir)
    )
  ) {
    return false;
  }

  logMainProcess(`[main] Self-installing into /Applications from: ${executablePath}`);

  try {
    // No conflictHandler on purpose: the mover's defaults are the installer
    // semantics we want — replace a stale copy, hand off to a running one.
    if (app.moveToApplicationsFolder()) {
      return true;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logMainProcess(`[main] Self-install into /Applications failed: ${reason}`);
    await quitWithManualMoveGuidance(
      executablePath,
      error instanceof Error ? `Automatic install failed: ${error.message}` : undefined
    );
    return true;
  }

  logMainProcess("[main] Self-install into /Applications was not performed");
  await quitWithManualMoveGuidance(executablePath);
  return true;
}
