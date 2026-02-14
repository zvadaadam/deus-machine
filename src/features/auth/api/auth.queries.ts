import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { AuthService } from "./auth.service";
import { useAuthStore } from "../store/authStore";

export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.auth.status,
    queryFn: AuthService.checkStatus,
    staleTime: Infinity,
    retry: false,
  });
}

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

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: AuthService.logout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status });
    },
  });
}
