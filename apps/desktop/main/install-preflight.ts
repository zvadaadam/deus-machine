import { app, dialog } from "electron";
import { join, resolve, sep } from "path";

function isInsideDirectory(filePath: string, directoryPath: string): boolean {
  const normalizedDirectory = `${resolve(directoryPath)}${sep}`;
  const normalizedFile = resolve(filePath);
  return normalizedFile.startsWith(normalizedDirectory);
}

export function isApplicationsInstallPath(executablePath: string, homeDir: string): boolean {
  return (
    isInsideDirectory(executablePath, "/Applications") ||
    isInsideDirectory(executablePath, join(homeDir, "Applications"))
  );
}

function buildMovePromptDetail(executablePath: string, extraReason?: string): string {
  return [
    "Deus needs to run from Applications on macOS.",
    "",
    "Launching directly from a disk image, Downloads, or another transient location can cause macOS to randomize the app path and break bundled backend processes.",
    "",
    `Current location: ${executablePath}`,
    extraReason ? "" : null,
    extraReason ? extraReason : null,
    "",
    "Move Deus to Applications now, then reopen it from there.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function ensureInstalledInApplications(): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return false;
  }

  const executablePath = app.getPath("exe");
  if (isApplicationsInstallPath(executablePath, app.getPath("home"))) {
    return false;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: "Move Deus to Applications?",
    detail: buildMovePromptDetail(executablePath),
  });

  if (response !== 0) {
    app.quit();
    return true;
  }

  try {
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === "exists") {
          return (
            dialog.showMessageBoxSync({
              type: "question",
              buttons: ["Cancel", "Replace Existing App"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
              message: "Replace the existing Deus app?",
              detail:
                "An existing copy of Deus is already in Applications. Replacing it will move this version into its place.",
            }) === 1
          );
        }

        if (conflictType === "existsAndRunning") {
          dialog.showMessageBoxSync({
            type: "warning",
            buttons: ["OK"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            message: "Deus is already running from Applications",
            detail:
              "Close the running copy of Deus, then reopen this installer build and try again.",
          });
        }

        return false;
      },
    });

    if (moved) {
      return true;
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: "Move Deus to Applications manually",
      detail: buildMovePromptDetail(
        executablePath,
        error instanceof Error ? `Move failed: ${error.message}` : undefined
      ),
    });
    app.quit();
    return true;
  }

  await dialog.showMessageBox({
    type: "error",
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Move Deus to Applications manually",
    detail: buildMovePromptDetail(executablePath),
  });
  app.quit();
  return true;
}
