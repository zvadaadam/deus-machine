import { app, dialog } from "electron";
import { execFileSync } from "child_process";
import { realpathSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
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

function readInstalledBundleArchs(bundlePath: string, executableName: string): string[] | null {
  try {
    const archs = execFileSync(
      "/usr/bin/lipo",
      ["-archs", join(bundlePath, "Contents", "MacOS", executableName)],
      { encoding: "utf8", timeout: 3_000 }
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return archs.length > 0 ? archs : null;
  } catch {
    return null;
  }
}

/**
 * The machine's native architecture — NOT process.arch, which reports x64
 * when an x64 build runs under Rosetta on Apple Silicon.
 */
function getMachineNativeArch(): "arm64" | "x86_64" {
  if (process.arch === "arm64") {
    return "arm64";
  }
  try {
    const translated = execFileSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], {
      encoding: "utf8",
      timeout: 3_000,
    }).trim();
    return translated === "1" ? "arm64" : "x86_64";
  } catch {
    // The sysctl key does not exist on Intel hardware.
    return "x86_64";
  }
}

function shouldReplaceSameVersionForArch(bundlePath: string, executableName: string): boolean {
  const installedArchs = readInstalledBundleArchs(bundlePath, executableName);
  if (installedArchs === null) {
    // Unreadable binary — replacing also repairs a broken install.
    return true;
  }
  const nativeArch = getMachineNativeArch();
  const incomingArch = process.arch === "arm64" ? "arm64" : "x86_64";
  // Only a native build may replace a same-version install, and only when the
  // installed copy cannot run natively (an x64 leftover on Apple Silicon). A
  // Rosetta build must never displace a native install.
  return incomingArch === nativeArch && !installedArchs.includes(nativeArch);
}

function readBundleShortVersion(bundlePath: string): string | null {
  try {
    const version = execFileSync(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(bundlePath, "Contents", "Info.plist"),
      ],
      { encoding: "utf8", timeout: 3_000 }
    ).trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftPart = left[index];
    const rightPart = right[index];
    // Semver: when a prerelease is a prefix of the other, the shorter is older.
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      // Semver: numeric identifiers sort below alphanumeric ones.
      return leftNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): { core: number[]; prerelease: string[] | null } | null => {
    const match = value.trim().match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/);
    if (!match) return null;
    return {
      core: match[1].split(".").map(Number),
      prerelease: match[2] ? match[2].split(".") : null,
    };
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) {
    return null;
  }
  for (let index = 0; index < Math.max(leftParts.core.length, rightParts.core.length); index++) {
    const delta = (leftParts.core[index] ?? 0) - (rightParts.core[index] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  // Semver: a release outranks any prerelease of the same core version.
  if (!leftParts.prerelease && !rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  return comparePrereleaseIdentifiers(leftParts.prerelease, rightParts.prerelease);
}

/**
 * An existing install is replaced when the launched copy is strictly newer —
 * opening an old (or already-installed) DMG must not silently downgrade — or
 * when versions match and the caller determined the replacement is justified
 * for architecture reasons (a native build superseding a non-native install).
 * Unknown or unparseable versions replace, preserving plain installer
 * semantics.
 */
export function shouldReplaceExistingInstall(
  installedVersion: string | null,
  incomingVersion: string,
  replaceSameVersionForArch: boolean
): boolean {
  if (!installedVersion) {
    return true;
  }
  const comparison = compareVersions(installedVersion, incomingVersion);
  if (comparison === null || comparison < 0) {
    return true;
  }
  return comparison === 0 && replaceSameVersionForArch;
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
 * An installed copy is only replaced when this launch is strictly newer;
 * opening an old or already-installed DMG opens the installed app instead of
 * silently downgrading it.
 *
 * Returns true when startup must stop — the app is relaunching from
 * Applications, handing off to an installed copy, or quitting after a failed
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

  // <bundle>.app/Contents/MacOS/<binary> → <bundle>.app
  const bundleName = basename(resolve(executablePath, "..", "..", ".."));
  const installedBundlePath = join("/Applications", bundleName);
  let handedOffToInstalledCopy = false;

  try {
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        // "existsAndRunning": defer to the mover — it focuses the running copy.
        if (conflictType !== "exists") {
          return true;
        }
        if (
          shouldReplaceExistingInstall(
            readBundleShortVersion(installedBundlePath),
            app.getVersion(),
            shouldReplaceSameVersionForArch(installedBundlePath, basename(executablePath))
          )
        ) {
          return true;
        }
        handedOffToInstalledCopy = true;
        return false;
      },
    });
    if (moved) {
      return true;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logMainProcess(`[main] Self-install into /Applications failed: ${reason}`);
    await quitWithManualMoveGuidance(executablePath, `Automatic install failed: ${reason}`);
    return true;
  }

  if (handedOffToInstalledCopy) {
    logMainProcess(
      `[main] Same-or-newer Deus already installed — opening ${installedBundlePath} instead`
    );
    // Release the lock before launching the installed copy: it boots while
    // this process is still tearing down, and it must win the lock instead of
    // quitting as a second instance.
    app.releaseSingleInstanceLock();
    try {
      execFileSync("/usr/bin/open", [installedBundlePath], { timeout: 10_000 });
    } catch (error) {
      logMainProcess(
        "[main] Failed to open installed copy: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
    app.quit();
    return true;
  }

  logMainProcess("[main] Self-install into /Applications was not performed");
  await quitWithManualMoveGuidance(executablePath);
  return true;
}
