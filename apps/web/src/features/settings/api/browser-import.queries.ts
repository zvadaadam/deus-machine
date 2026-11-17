/**
 * Connect-browser data layer.
 *
 * Profiles + decrypted cookies come from the backend operations
 * (browserProfiles, browserCookies). Injection into the persist:browser
 * session is a native Electron op, so the connect mutation hands the cookies to
 * the main process via the `browser_import_cookies` IPC channel.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { invoke } from "@/platform/electron/invoke";
import type { BrowserId, BrowserProfile, ImportCookiesResult } from "@shared/types/browser-import";

export type { BrowserId, BrowserProfile };

const profilesKey = ["settings", "browser", "profiles"] as const;

export function useBrowserProfiles() {
  return useQuery({
    queryKey: profilesKey,
    queryFn: () => call(api.browserProfiles),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Read+decrypt a profile's cookies (backend, pops the Keychain prompt) then
 * inject them into the persist:browser session (main process).
 */
export function useConnectBrowserProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (profile: BrowserProfile): Promise<ImportCookiesResult> => {
      // First read per browser blocks on the macOS Keychain prompt, which can
      // outlive the default request timeout — give the user 2 minutes.
      const cookies = await call(
        api.browserCookies,
        { browserId: profile.browserId, profileDir: profile.profileDir },
        { timeoutMs: 120_000 }
      );
      return invoke<ImportCookiesResult>("browser_import_cookies", { cookies });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profilesKey });
    },
  });
}

/** Wipe the in-app browser session (cookies + storage + cache). */
export function useClearBrowserSession() {
  return useMutation({
    mutationFn: (): Promise<{ success: boolean }> =>
      invoke<{ success: boolean }>("browser_clear_session"),
  });
}
