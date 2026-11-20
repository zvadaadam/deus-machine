import type { QueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import type { Settings } from "@shared/types/settings";
import { queryClient } from "@/shared/api/queryClient";
import { capabilities } from "@/platform/capabilities";
import type { AnalyticsEventMap, AnalyticsEvent } from "./events";

// Each host/account has its own cache. Switching hosts closes the gate even
// before React has mounted the new host or its settings request has finished.
let enabledFor: QueryClient | undefined;
let initialized = false;
let launchTracked = false;
const mayCapture = () => enabledFor === queryClient;

export function stopAnalytics(): void {
  if (!enabledFor) return;
  enabledFor = undefined;
  try {
    posthog.opt_out_capturing();
  } catch {
    // The application gate is already closed.
  }
}

/** Only a reply from this host can enable usage analytics. */
export function applyAnalyticsSettings(
  host: QueryClient,
  settings: Pick<Settings, "analytics_enabled" | "theme">
): void {
  if (host !== queryClient) return;
  if (settings.analytics_enabled === false) return stopAnalytics();
  if (enabledFor === host) return;
  enabledFor = host;
  try {
    if (!initialized) {
      posthog.init("phc_2z6yzR1XS76u7iEjcYvdZonNLJfCECJYqWlRoYqXmM0", {
        api_host: "https://us.i.posthog.com",
        defaults: "2026-01-30",
        opt_out_capturing_by_default: true,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        persistence: "localStorage",
        before_send: (event) => (mayCapture() ? event : null),
      });
      initialized = true;
    }
    posthog.opt_in_capturing({ captureEventName: false });
    posthog.setPersonProperties({ theme: settings.theme ?? "system" });
    if (capabilities.ipcInvoke && !launchTracked) {
      void window
        .electronAPI!.getAppVersion()
        .catch(() => "unknown")
        .then((version) => {
          if (launchTracked || host !== queryClient || !mayCapture()) return;
          launchTracked = true;
          track("app_launched", { version });
        });
    }
  } catch {
    stopAnalytics();
  }
}

/** Track a typed event once the current host permits capture. */
export function track<E extends AnalyticsEvent>(
  event: E,
  ...args: AnalyticsEventMap[E] extends Record<string, never>
    ? []
    : [properties: AnalyticsEventMap[E]]
): void {
  if (!mayCapture()) return;
  try {
    posthog.capture(event, args[0] as Record<string, unknown> | undefined);
  } catch {
    // Analytics must never crash the app.
  }
}
