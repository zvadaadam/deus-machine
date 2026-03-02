import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import type { ComponentType, ReactNode, ErrorInfo } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { MainLayout } from "./layouts/MainLayout";
import { DetachedBrowserWindow } from "@/features/browser/ui/DetachedBrowserWindow";
import { ErrorFallback, DashboardError } from "@/shared/components";
import { reportError } from "@/shared/utils/errorReporting";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { OnboardingOverlay } from "@/features/onboarding";
import { useSettings } from "@/features/settings";
import { useAuth, PairGatePage } from "@/features/auth";
import { isTauriEnv, invoke } from "@/platform/tauri";
import { initNotifications } from "@/platform/notifications";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import { useWorkspaceInitEvents } from "@/features/workspace/hooks/useWorkspaceInitEvents";
import { useAutoUpdate, useUpdateToast, UpdateProvider } from "@/features/updates";
import { useAnalyticsConsent } from "@/platform/analytics";

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
  const auth = useAuth();
  const settingsQuery = useSettings();
  const windowShownRef = useRef(false);

  // Request OS notification permission once on mount
  useEffect(() => {
    initNotifications();
  }, []);

  // Global listener: fire OS notifications for ALL session events when backgrounded
  useGlobalSessionNotifications();

  // Global listener: workspace init progress → invalidate queries on completion
  useWorkspaceInitEvents();

  // Sync PostHog opt-in/out state with analytics_enabled setting
  useAnalyticsConsent();

  // Auto-update: check on launch + every 5 min, show toast when ready
  const autoUpdate = useAutoUpdate();
  useUpdateToast(autoUpdate);

  const showOnboarding = !settingsQuery.isError && !settingsQuery.data?.onboarding_completed;

  // Boot diagnostics — trace the window-show flow so we can see what's blocking
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.log("[App] AppContent mount — auth:", {
        isLoading: auth.isLoading,
        isAuthenticated: auth.isAuthenticated,
      });
      console.log("[App] AppContent mount — settings:", {
        isLoading: settingsQuery.isLoading,
        isError: settingsQuery.isError,
        hasData: !!settingsQuery.data,
        onboardingCompleted: settingsQuery.data?.onboarding_completed,
        showOnboarding,
      });
    }
  }, [
    auth.isLoading,
    auth.isAuthenticated,
    settingsQuery.isLoading,
    settingsQuery.isError,
    settingsQuery.data,
    showOnboarding,
  ]);

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

  // Remote browser auth gate: show pairing page if not authenticated
  if (auth.isLoading) return null;
  if (!auth.isAuthenticated) return <PairGatePage onPaired={auth.onPaired} />;

  // While settings load, render nothing — window is hidden anyway
  if (settingsQuery.isLoading) return null;

  if (showOnboarding) {
    return <OnboardingOverlay />;
  }

  return (
    <UpdateProvider value={autoUpdate}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={
              <ConditionalErrorBoundary
                fallback={DashboardError}
                onReset={reset}
                onError={(error, info) => {
                  reportError(error, {
                    source: "react.error-boundary.root",
                    extra: { componentStack: info.componentStack ?? undefined },
                  });
                  if (typeof window !== "undefined") {
                    (
                      window as { __APP_LAST_COMPONENT_STACK__?: string }
                    ).__APP_LAST_COMPONENT_STACK__ = info.componentStack ?? undefined;
                  }
                }}
              >
                <MainLayout />
              </ConditionalErrorBoundary>
            }
          />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </UpdateProvider>
  );
}

/**
 * Safety net: ensure the window always becomes visible.
 *
 * The main window starts hidden (visible: false in tauri.conf.json) to avoid
 * a flash before onboarding/content is ready. Normally the frontend calls
 * show_main_window or enter_onboarding_mode within ~1-2s. But if anything
 * goes wrong (settings fetch hangs, unexpected error, hook crash), the window
 * stays hidden and the user sees only a dock icon with no window.
 *
 * This timeout guarantees the window appears within WINDOW_SHOW_TIMEOUT_MS,
 * no matter what. It's a last resort — the normal flow or ErrorFallback
 * should show the window sooner.
 */
const WINDOW_SHOW_TIMEOUT_MS = 5_000;

function useWindowShowSafetyNet() {
  const shownRef = useRef(false);
  useEffect(() => {
    if (!isTauriEnv || shownRef.current) return;
    const timer = setTimeout(() => {
      if (!shownRef.current) {
        shownRef.current = true;
        console.warn("[App] Safety net: force-showing window after timeout");
        invoke("show_main_window").catch(console.error);
      }
    }, WINDOW_SHOW_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
}

function App() {
  // Safety net — force-show window if nothing else does within 5s
  useWindowShowSafetyNet();

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
