import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { capabilities } from "@/platform/capabilities";
import type { AnalyticsEventMap, AnalyticsEvent } from "./events";

let client: typeof posthog | undefined;

export function startAnalytics(): void {
  if (navigator.webdriver) return;
  try {
    client = posthog.init("phc_2z6yzR1XS76u7iEjcYvdZonNLJfCECJYqWlRoYqXmM0", {
      api_host: "https://us.i.posthog.com",
      defaults: "2026-01-30",
      consent_persistence_name: "deus.posthog.consent", // Ignore the retired switch's SDK marker.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: "localStorage",
    });
  } catch {
    // The app can run without analytics.
  }
}

export function track<E extends AnalyticsEvent>(
  event: E,
  ...args: AnalyticsEventMap[E] extends Record<string, never>
    ? []
    : [properties: AnalyticsEventMap[E]]
): void {
  try {
    client?.capture(event, args[0] as Record<string, unknown> | undefined);
  } catch {
    // Analytics must never crash the app.
  }
}

/** Set the theme when the shell opens and record the version on desktop. */
export function useAppLaunch(theme = "system"): void {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || !client) return;
    reported.current = true;
    try {
      client.setPersonProperties({ theme });
      if (capabilities.ipcInvoke) {
        void window
          .electronAPI!.getAppVersion()
          .catch(() => "unknown")
          .then((version) => track("app_launched", { version }));
      }
    } catch {
      // Analytics must never crash the app.
    }
  }, [theme]);
}
