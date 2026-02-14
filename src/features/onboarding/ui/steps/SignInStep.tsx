import { useEffect } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useStartLogin } from "@/features/auth/api/auth.queries";
import { useAuthStore } from "@/features/auth/store/authStore";
import { isTauriEnv, listen } from "@/platform/tauri";

interface SignInStepProps {
  onNext: () => void;
  onBack: () => void;
}

/**
 * Onboarding sign-in step — shown after the Welcome animation.
 *
 * Desktop: opens browser to Hivenet for OAuth, listens for deep-link callback.
 * Web dev mode: auto-advances (no Tauri auth available).
 */
export function SignInStep({ onNext, onBack }: SignInStepProps) {
  const { mutate: startLogin } = useStartLogin();
  const loginInProgress = useAuthStore((s) => s.loginInProgress);
  const setLoginInProgress = useAuthStore((s) => s.setLoginInProgress);
  const loginError = useAuthStore((s) => s.loginError);
  const setLoginError = useAuthStore((s) => s.setLoginError);

  // Web mode: skip auth entirely — no Tauri Keychain available
  useEffect(() => {
    if (!isTauriEnv) onNext();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- fire once on mount

  // Listen for deep-link callback from Tauri backend
  useEffect(() => {
    if (!isTauriEnv) return;

    const unlistenSuccess = listen("auth:login-complete", () => {
      setLoginInProgress(false);
      onNext();
    });

    const unlistenError = listen<string>("auth:login-error", (event) => {
      setLoginInProgress(false);
      setLoginError(event.payload || "Login failed. Please try again.");
    });

    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [onNext, setLoginInProgress, setLoginError]);

  // Web mode renders nothing — auto-advances above
  if (!isTauriEnv) return null;

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-6 py-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold text-white">Sign In</h2>
        <p className="text-sm text-white/50">
          Sign in with Hivenet to sync your workspaces and settings.
        </p>
      </div>

      {loginInProgress ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="h-5 w-5 animate-spin text-white/40 motion-reduce:animate-none" />
          <p className="text-sm text-white/40">Waiting for login in browser...</p>
          <button
            type="button"
            onClick={() => setLoginInProgress(false)}
            className="mt-1 text-xs text-white/25 transition-colors duration-200 hover:text-white/50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          {loginError && <p className="max-w-xs text-center text-sm text-red-400">{loginError}</p>}
          <button
            type="button"
            onClick={() => {
              setLoginError(null);
              startLogin();
            }}
            className="mt-2 flex items-center gap-2 rounded-full bg-white px-10 py-3 text-sm font-semibold text-black/90 transition-all duration-200 hover:scale-[1.03] hover:bg-white/95 active:scale-[0.98]"
            style={{
              boxShadow: "0 0 30px -4px oklch(0.65 0.15 264 / 0.3), 0 2px 12px rgba(0,0,0,0.2)",
            }}
          >
            {loginError ? "Try again" : "Sign in with Hivenet"}
            <ExternalLink className="h-3.5 w-3.5 text-black/40" />
          </button>
        </>
      )}

      <div className="flex w-full items-center pt-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl px-6 py-2.5 text-sm font-medium text-white/50 transition-colors duration-200 hover:text-white/80"
        >
          Back
        </button>
      </div>
    </div>
  );
}
