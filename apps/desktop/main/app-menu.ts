/**
 * Application Menu
 *
 * Sets up the native macOS/Windows/Linux menu bar with proper app name,
 * standard Edit shortcuts (copy/paste/undo), and app controls.
 */

import { Menu, shell, BrowserWindow } from "electron";

export function setupAppMenu(): void {
  const isMac = process.platform === "darwin";
  const appName = "Deus";

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu (first item = app name)
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { role: "about" as const, label: `About ${appName}` },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const, label: `Hide ${appName}` },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const, label: `Quit ${appName}` },
            ],
          },
        ]
      : []),

    // Edit menu — standard text editing shortcuts
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },

    // View menu
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    // Window menu
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },

    // Help menu
    {
      label: "Help",
      submenu: [
        {
          label: "Documentation",
          click: () => shell.openExternal("https://deusmachine.ai/docs"),
        },
        {
          label: "Report Issue",
          click: () => shell.openExternal("https://github.com/zvadaadam/box-ide/issues"),
        },
        { type: "separator" },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Cmd+Option+I" : "Ctrl+Shift+I",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.toggleDevTools();
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
