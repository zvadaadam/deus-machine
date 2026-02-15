import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "../global.css";
import { reportError } from "@/shared/utils/errorReporting";

// Ensure Tauri class is applied (backup check - head script may run before __TAURI__ is available)
if (
  typeof window !== "undefined" &&
  ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)
) {
  document.documentElement.classList.add("tauri");
}

// Window focus/blur tracking — toggles .window-inactive for vibrancy dimming
window.addEventListener("focus", () =>
  document.documentElement.classList.remove("window-inactive")
);
window.addEventListener("blur", () => document.documentElement.classList.add("window-inactive"));

if (typeof window !== "undefined") {
  const w = window as Window & { __hiveErrorHandlers__?: boolean };
  if (!w.__hiveErrorHandlers__) {
    w.__hiveErrorHandlers__ = true;

    window.addEventListener("error", (event) => {
      reportError(event.error ?? event.message, {
        source: "window.error",
        extra: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      reportError(event.reason, { source: "window.unhandledrejection" });
    });
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
