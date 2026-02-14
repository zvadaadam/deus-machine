import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isTauriEnv, listen } from "@/platform/tauri";
import { queryKeys } from "@/shared/api/queryKeys";
import { useAuthStatus } from "../api/auth.queries";
import { useAuthStore } from "../store/authStore";
import { LoginScreen } from "./LoginScreen";

interface AuthGateProps {
  children: ReactNode;
}

/**
 * AuthGate — wraps the entire app behind authentication.
 *
 * In Tauri (desktop): checks Keychain for stored identity. If not found,
 * shows LoginScreen. Listens for the deep-link callback event to
 * invalidate auth state after browser-based OAuth completes.
 *
 * In web dev mode (!isTauriEnv): skips auth entirely — pass-through.
 */
export function AuthGate({ children }: AuthGateProps) {
  // Skip auth gate entirely in web dev mode
  if (!isTauriEnv) {
    return <>{children}</>;
  }

  return <AuthGateInner>{children}</AuthGateInner>;
}

function AuthGateInner({ children }: AuthGateProps) {
  const { data, isLoading } = useAuthStatus();
  const queryClient = useQueryClient();
  const setLoginInProgress = useAuthStore((s) => s.setLoginInProgress);

  // Listen for deep-link login completion (or failure) from Tauri backend
  useEffect(() => {
    const unlistenSuccess = listen("auth:login-complete", () => {
      setLoginInProgress(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status });
    });

    const unlistenError = listen<string>("auth:login-error", () => {
      setLoginInProgress(false);
    });

    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [queryClient, setLoginInProgress]);

  // Loading state — brief flash while Keychain is read
  if (isLoading) return null;

  // Not authenticated — show login
  if (!data?.authenticated) return <LoginScreen />;

  // Authenticated — render the app
  return <>{children}</>;
}
