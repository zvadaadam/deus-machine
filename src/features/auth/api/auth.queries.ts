import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { AuthService } from "./auth.service";
import { useAuthStore } from "../store/authStore";

/** Reads auth status from Keychain via native layer. Cached indefinitely — only invalidated on login/logout events. */
export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.auth.status,
    queryFn: AuthService.checkStatus,
    staleTime: Infinity,
    retry: false,
  });
}

/** Opens system browser to Hivenet for OAuth. Sets loginInProgress flag, cleared on error or deep-link callback. */
export function useStartLogin() {
  const setLoginInProgress = useAuthStore((s) => s.setLoginInProgress);

  return useMutation({
    mutationFn: () => {
      setLoginInProgress(true);
      return AuthService.startLogin();
    },
    onError: () => {
      setLoginInProgress(false);
    },
  });
}

/** Clears Keychain credentials and resets auth state, returning user to login screen. */
export function useLogout() {
  const queryClient = useQueryClient();
  const setLoginInProgress = useAuthStore((s) => s.setLoginInProgress);

  return useMutation({
    mutationFn: AuthService.logout,
    onSuccess: () => {
      setLoginInProgress(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status });
    },
  });
}
