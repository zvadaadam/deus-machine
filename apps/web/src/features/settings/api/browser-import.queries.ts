/**
 * Connect-browser data layer.
 *
 * Profiles + decrypted cookies come from the backend REST routes
 * (/browser/profiles, /browser/cookies). Injection into the persist:browser
 * session is a native Electron op, so the connect mutation hands the cookies to
 * the main process via the `browser_import_cookies` IPC channel.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { invoke } from "@/platform/electron/invoke";
import type {
  BrowserId,
  BrowserProfile,
  ImportCookie,
  ImportCookiesResult,
} from "@shared/types/browser-import";

export type { BrowserId, BrowserProfile };

const profilesKey = ["settings", "browser", "profiles"] as const;

export function useBrowserProfiles() {
  return useQuery({
    queryKey: profilesKey,
    queryFn: async () => {
      const res = await apiClient.get<{ profiles: BrowserProfile[] }>("/browser/profiles");
      return res.profiles;
    },
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
      const { cookies } = await apiClient.post<{ cookies: ImportCookie[]; count: number }>(
        "/browser/cookies",
        { browserId: profile.browserId, profileDir: profile.profileDir }
      );
      return invoke<ImportCookiesResult>("browser_import_cookies", { cookies });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profilesKey });
    },
  });
}
