// Loaded before the app's main module so even its first window gives the keyboard to the person.
const { app, BrowserWindow } = require("electron");

BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.focus = () => {};
BrowserWindow.prototype.moveTop = () => {};
app.focus = () => {};

if (process.platform === "darwin") {
  app.setActivationPolicy("accessory");
  app.dock.show = () => {};
}

// Detached Developer Tools would take the keyboard in a native window outside BrowserWindow.
app.on("web-contents-created", (_event, contents) => {
  contents.openDevTools = () => {};
});

// An accessory window can join the person's current Space, including a full-screen one.
app.on("browser-window-created", (_event, window) => {
  if (process.platform !== "linux") window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
});
