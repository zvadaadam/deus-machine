import posthog from "posthog-js";
import { capabilities } from "@/platform/capabilities";
import type { AnalyticsEventMap, AnalyticsEvent } from "./events";

let client: typeof posthog | undefined;

// PostHog also attaches URLs inside session and person properties, including $set_once.
function stripUrlFragments(record: object): void {
  const fields = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.includes("#")) {
      fields[key] = /(?:url|href|referrer)$/i.test(key)
        ? value.slice(0, value.indexOf("#"))
        : value.replace(/((?:\b[a-z][\w+.-]*:|\/)[^\s#]*)#[^\s]*/gi, "$1");
    } else if (value && typeof value === "object") {
      stripUrlFragments(value);
    }
  }
}

export function startAnalytics(): void {
  if (navigator.webdriver || client) return;
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
      // /flags sends the initial URL outside before_send. Deus uses no PostHog flags.
      advanced_disable_flags: true,
      before_send: (event) => {
        if (event) stripUrlFragments(event);
        return event;
      },
    });
    if (capabilities.ipcInvoke) {
      void window
        .electronAPI!.getAppVersion()
        .catch(() => "unknown")
        .then((version) => track("app_launched", { version }));
    }
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

export function reportTheme(theme: string | undefined): void {
  if (theme === undefined) return;
  try {
    client?.setPersonProperties({ theme });
  } catch {
    // Analytics must never crash the app.
  }
}
