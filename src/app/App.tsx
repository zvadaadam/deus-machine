import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import type { ComponentType, ReactNode, ErrorInfo } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { QueryErrorResetBoundary, useQueryClient } from "@tanstack/react-query";
import { MainLayout } from "./layouts/MainLayout";
import { DetachedBrowserWindow } from "@/features/browser/ui/DetachedBrowserWindow";
import { ErrorFallback, DashboardError } from "@/shared/components";
import { reportError } from "@/shared/utils/errorReporting";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { useAuthStatus, LoginScreen } from "@/features/auth";
import { useAuthStore } from "@/features/auth/store/authStore";
import { OnboardingOverlay } from "@/features/onboarding";
import { useSettings } from "@/features/settings";
import { isTauriEnv, invoke, listen } from "@/platform/tauri";
import { queryKeys } from "@/shared/api/queryKeys";

// Detect if this window instance is the detached browser popup.
// The main window creates it with ?window=browser-detached in the URL.
const isDetachedBrowser =
  new URLSearchParams(window.location.search).get("window") === "browser-detached";
type ConditionalErrorBoundaryProps = {
  fallback: ComponentType<FallbackProps>;
  onReset?: () => void;
  onError?: (error: unknown, info: ErrorInfo) => void;
  children: ReactNode;
};

function ConditionalErrorBoundary({
  fallback,
  onReset,
  onError,
  children,
}: ConditionalErrorBoundaryProps) {
  return (
    <ErrorBoundary FallbackComponent={fallback} onReset={onReset} onError={onError}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * Gates between onboarding and the main app.
 *
 * When onboarding is active, ONLY OnboardingOverlay renders — no MainLayout,
 * no sidebar, no workspace panels. This ensures the transparent window shows
 * the desktop through the semi-transparent scrim, not the app's own UI.
 */
function AppContent({ reset }: { reset: () => void }) {
  const settingsQuery = useSettings();
  const authQuery = useAuthStatus();
  const setLoginInProgress = useAuthStore((s) => s.setLoginInProgress);
  const queryClient = useQueryClient();
  const windowShownRef = useRef(false);

  const showOnboarding = !settingsQuery.isError && !settingsQuery.data?.onboarding_completed;

  // Deep-link event listeners for auth — always active so they cover both
  // onboarding (SignInStep) and post-onboarding (LoginScreen for returning users).
  useEffect(() => {
    if (!isTauriEnv) return;

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

  // Show the main window whenever we transition OUT of onboarding.
  // Covers both first launch (window starts hidden via tauri.conf.json)
  // and replay-onboarding (exit_onboarding_mode hides the window).
  useEffect(() => {
    if (settingsQuery.isLoading) return;
    if (showOnboarding) {
      // Entering onboarding — reset so we re-show when it completes
      windowShownRef.current = false;
      return;
    }
    if (windowShownRef.current) return;
    if (isTauriEnv) {
      invoke("show_main_window").catch(console.error);
      windowShownRef.current = true;
    }
  }, [settingsQuery.isLoading, showOnboarding]);

  // While settings load, render nothing — window is hidden anyway
  if (settingsQuery.isLoading) return null;

  if (showOnboarding) {
    return <OnboardingOverlay />;
  }

  // Returning user who logged out — show login screen (not full re-onboarding)
  if (isTauriEnv && !authQuery.isLoading && !authQuery.data?.authenticated) {
    return <LoginScreen />;
  }

  return (
    <>
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={
              <ConditionalErrorBoundary fallback={DashboardError} onReset={reset}>
                <MainLayout />
              </ConditionalErrorBoundary>
            }
          />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </>
  );
}

function App() {
  // Detached browser window: minimal shell with just the browser panel
  if (isDetachedBrowser) {
    return (
      <QueryClientProvider>
        <ThemeProvider>
          <DetachedBrowserWindow />
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ConditionalErrorBoundary
            fallback={ErrorFallback}
            onReset={reset}
            onError={(error, info) => {
              reportError(error, {
                source: "react.error-boundary",
                extra: { componentStack: info.componentStack ?? undefined },
              });
              if (typeof window !== "undefined") {
                (window as { __APP_LAST_COMPONENT_STACK__?: string }).__APP_LAST_COMPONENT_STACK__ =
                  info.componentStack ?? undefined;
              }
            }}
          >
            <ThemeProvider>
              <AppContent reset={reset} />
            </ThemeProvider>
          </ConditionalErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );
}

export default App;
