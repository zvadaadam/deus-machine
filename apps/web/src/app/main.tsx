import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";
import "../global.css";
import { reportError } from "@/shared/utils/errorReporting";
import {
  captureCloudSessionFromFragment,
  ensureWebCloudSession,
} from "@/features/session/cloud/webCloudDirectConfig";
import { installCloudDataAdapter } from "@/features/session/cloud/cloudDataAdapter";

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

// Fully Mac-closed web: capture a `#token=…` deus_cloud_session handed back by
// the deus-cloud login redirect, store it, and scrub the fragment — before React
// mounts and any route reads the URL. A no-op when there's no such fragment
// (electron/web-dev/relay never carry one).
captureCloudSessionFromFragment();

// Fully Mac-closed web: serve workspace/session reads from agnt (no Mac backend
// to answer q:request). A no-op on every backed build.
installCloudDataAdapter();

// Fully Mac-closed web: with no deus_cloud_session in hand, go sign in (loop
// guarded). A no-op on every backed build and once signed in.
ensureWebCloudSession();

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
