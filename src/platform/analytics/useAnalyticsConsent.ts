/**
 * Syncs PostHog opt-in/out state with the analytics_enabled setting.
 *
 * Consent model: OPT-OUT. Default is true (tracking enabled unless user disables).
 * Mount once in AppContent — runs whenever the setting changes.
 */
import { useEffect, useRef } from "react";
import { useSettings } from "@/features/settings";
import { setAnalyticsEnabled, identifyUser, track } from "./track";
import { isTauriEnv } from "@/platform/tauri";

export function useAnalyticsConsent(): void {
  const { data: settings } = useSettings();
  const prevEnabled = useRef<boolean | null>(null);

  useEffect(() => {
    const enabled = settings?.analytics_enabled !== false;

    // Skip if unchanged
    if (prevEnabled.current === enabled) return;
    prevEnabled.current = enabled;

    setAnalyticsEnabled(enabled);

    if (enabled) {
      identifyUser({
        theme: settings?.theme ?? "system",
        claude_provider: settings?.claude_provider,
      });

      // Track app launch once on first consent sync
      if (isTauriEnv) {
        import("@tauri-apps/api/app")
          .then(({ getVersion }) => getVersion())
          .then((version) => track("app_launched", { version }))
          .catch(() => track("app_launched", { version: "unknown" }));
      }
    }
  }, [settings?.analytics_enabled, settings?.theme, settings?.claude_provider]);
}
