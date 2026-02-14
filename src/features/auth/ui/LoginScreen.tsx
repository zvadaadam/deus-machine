import { ExternalLink, Loader2, Terminal } from "lucide-react";
import { useStartLogin } from "../api/auth.queries";
import { useAuthStore } from "../store/authStore";

/**
 * LoginScreen — Shown on first launch before authentication.
 *
 * Single "Sign in" button opens the browser to Hivenet where the user
 * picks their provider (Google, GitHub, etc.). Provider selection lives
 * on the web — not in the desktop app.
 */
export function LoginScreen() {
  const { mutate: startLogin } = useStartLogin();
  const loginInProgress = useAuthStore((s) => s.loginInProgress);
  const setLoginInProgress = useAuthStore((s) => s.setLoginInProgress);

  return (
    <div className="flex h-screen min-h-0 flex-1 items-center justify-center">
      <div className="w-full max-w-sm px-6">
        {/* Header */}
        <div className="mb-10 flex flex-col items-center text-center">
          <div className="bg-bg-elevated mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
            <Terminal className="text-text-tertiary h-7 w-7" strokeWidth={1.5} />
          </div>
          <h1 className="text-text-primary mb-2 text-lg font-semibold">Command</h1>
          <p className="text-text-tertiary max-w-md text-sm">Run multiple coding tasks at once.</p>
        </div>

        {/* Login */}
        {loginInProgress ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="text-text-tertiary h-5 w-5 animate-spin motion-reduce:animate-none" />
            <p className="text-text-tertiary text-sm">Waiting for login in browser...</p>
            <button
              type="button"
              onClick={() => setLoginInProgress(false)}
              className="text-text-muted hover:text-text-tertiary mt-2 cursor-pointer text-xs transition-colors duration-200"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <button
              type="button"
              onClick={() => startLogin()}
              className="bg-bg-elevated hover:bg-bg-raised flex cursor-pointer items-center gap-2 rounded-xl px-6 py-3 text-sm font-medium transition-colors duration-200"
            >
              <span className="text-text-primary">Sign in</span>
              <ExternalLink className="text-text-muted h-3.5 w-3.5" />
            </button>
            <p className="text-text-muted mt-3 text-xs">Opens your browser</p>
          </div>
        )}
      </div>
    </div>
  );
}
