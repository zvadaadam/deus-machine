/**
 * Analytics — thin PostHog wrapper with consent gating.
 *
 * Module-level boolean (_enabled) is synced by useAnalyticsConsent() on app boot.
 * PostHog's opt_out_capturing acts as a second gate at the network layer.
 * All calls are fire-and-forget — analytics must never crash the app.
 */
import posthog from "posthog-js";
import type { AnalyticsEventMap, AnalyticsEvent } from "./events";

let _enabled = true;

/** Sync consent state. Called by useAnalyticsConsent and the settings toggle. */
export function setAnalyticsEnabled(enabled: boolean): void {
  _enabled = enabled;
  try {
    if (enabled) {
      posthog.opt_in_capturing();
    } else {
      posthog.opt_out_capturing();
    }
  } catch {
    // Silent — PostHog may not be fully initialized yet
  }
}

/** Track a typed event. No-op when analytics disabled. */
export function track<E extends AnalyticsEvent>(
  event: E,
  ...args: AnalyticsEventMap[E] extends Record<string, never>
    ? []
    : [properties: AnalyticsEventMap[E]]
): void {
  if (!_enabled) return;
  try {
    posthog.capture(event, args[0] as Record<string, unknown> | undefined);
  } catch {
    // Analytics must never crash the app
  }
}

/** Identify user with non-PII traits for cohort analysis. */
export function identifyUser(traits?: Record<string, unknown>): void {
  if (!_enabled) return;
  try {
    posthog.setPersonProperties(traits ?? {});
  } catch {
    // Silent
  }
}
