import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";
import "../global.css";
import { reportError } from "@/shared/utils/errorReporting";

// Initialize Sentry before anything else.
// DSN is injected at build time via VITE_SENTRY_DSN env var (not hardcoded — open source repo).
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.DEV ? "development" : "production",
    release: `opendevs@${__APP_VERSION__}`,
    sendDefaultPii: true,
    enabled: !import.meta.env.DEV,
  });
}

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
  const w = window as Window & { __opendevsErrorHandlers__?: boolean };
  if (!w.__opendevsErrorHandlers__) {
    w.__opendevsErrorHandlers__ = true;

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

const posthogOptions = {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
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
    <PostHogProvider apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY} options={posthogOptions}>
      <App />
    </PostHogProvider>
  </React.StrictMode>
);
