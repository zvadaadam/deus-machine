import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";
import "../global.css";
import { reportError } from "@/shared/utils/errorReporting";

// Initialize Sentry before anything else.
// DSN is a public, write-only ingest token — safe to hardcode.
Sentry.init({
  dsn: "https://2c44c31c34c36fea97c1cc9aa2c8992c@o4510970844020736.ingest.us.sentry.io/4510971280097280",
  environment: import.meta.env.DEV ? "development" : "production",
  release: `deus@${__APP_VERSION__}`,
  sendDefaultPii: true,
  enabled: !import.meta.env.DEV,
});

// Ensure Electron class is applied (backup check - preload may not have run yet)
if ((window as any).electronAPI) {
  document.documentElement.classList.add("electron");
}

// Window focus/blur tracking — toggles .window-inactive for vibrancy dimming
window.addEventListener("focus", () =>
  document.documentElement.classList.remove("window-inactive")
);
window.addEventListener("blur", () => document.documentElement.classList.add("window-inactive"));

const w = window as Window & { __deusErrorHandlers__?: boolean };
if (!w.__deusErrorHandlers__) {
  w.__deusErrorHandlers__ = true;

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

const posthogOptions = {
  api_host: "https://us.i.posthog.com",
  defaults: "2026-01-30",
  opt_out_capturing_by_default: false,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  disable_session_recording: true,
  persistence: "localStorage" as const,
} as const;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PostHogProvider
      apiKey="phc_2z6yzR1XS76u7iEjcYvdZonNLJfCECJYqWlRoYqXmM0"
      options={posthogOptions}
    >
      <App />
    </PostHogProvider>
  </React.StrictMode>
);
