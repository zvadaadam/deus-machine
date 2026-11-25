import { app, ipcMain, type BrowserWindow } from "electron";
import {
  hasWorkspaceLinkScheme,
  parseWorkspaceLink,
  type WorkspaceLink,
} from "../../../shared/workspace-link";
import { focusWindow } from "./focus-window";

function linkFromArgv(argv: string[]): WorkspaceLink | null {
  for (const argument of argv.toReversed()) {
    const link = parseWorkspaceLink(argument);
    if (link) return link;
  }
  return null;
}

export function registerWorkspaceLinks(getWindow: () => BrowserWindow | null): void {
  // macOS delivers the launch link before ready. Other platforms put it in argv.
  let pending = linkFromArgv(process.argv);

  function bringForward(link?: WorkspaceLink): void {
    if (link) pending = link;
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    focusWindow(window);
    // Only a wake-up: the window's own page must ask for the ids through guarded IPC.
    if (link) window.webContents.send("workspace-link:available");
  }

  app.on("open-url", (event, text) => {
    event.preventDefault();
    const link = parseWorkspaceLink(text);
    if (link) bringForward(link);
  });
  app.on("second-instance", (_event, argv) => {
    const link = linkFromArgv(argv);
    if (link) bringForward(link);
    else if (!argv.some(hasWorkspaceLinkScheme)) bringForward();
  });
  ipcMain.handle("take_workspace_link", () => {
    const link = pending;
    pending = null;
    return link;
  });
}
