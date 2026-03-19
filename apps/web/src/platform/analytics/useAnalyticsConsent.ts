/**
 * Syncs PostHog opt-in/out state with the analytics_enabled setting.
 *
 * Consent model: OPT-OUT. Default is true (tracking enabled unless user disables).
 * Mount once in AppContent — runs whenever the setting changes.
 */
import { useEffect, useRef } from "react";
import { useSettings } from "@/features/settings";
import { setAnalyticsEnabled, identifyUser, track } from "./track";
import { isElectronEnv } from "@/platform/electron";

export function useAnalyticsConsent(): void {
  const { data: settings } = useSettings();
  const prevEnabled = useRef<boolean | null>(null);
  const appLaunchTracked = useRef(false);

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

      // Track app launch once per app lifecycle (guard prevents re-fire
      // if user toggles analytics off then back on)
      if (!appLaunchTracked.current && isElectronEnv) {
        appLaunchTracked.current = true;
        // In Electron, get version via the preload bridge
        window
          .electronAPI!.getAppVersion()
          .then((version) => track("app_launched", { version }))
          .catch(() => track("app_launched", { version: "unknown" }));
      }
    }
  }, [settings?.analytics_enabled, settings?.theme, settings?.claude_provider]);
}
