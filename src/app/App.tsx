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

  // Auto-update: check on launch + every 5 min, show toast when ready
  const autoUpdate = useAutoUpdate();
  useUpdateToast(autoUpdate);

  const showOnboarding = !settingsQuery.isError && !settingsQuery.data?.onboarding_completed;

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
              <ConditionalErrorBoundary fallback={DashboardError} onReset={reset}>
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
