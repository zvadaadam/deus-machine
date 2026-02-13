import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import type { ComponentType, ReactNode, ErrorInfo } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { MainLayout } from "./layouts/MainLayout";
import { ErrorFallback, DashboardError } from "@/shared/components";
import { reportError } from "@/shared/utils/errorReporting";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { OnboardingOverlay } from "@/features/onboarding";
import { useSettings } from "@/features/settings";
import { isTauriEnv, invoke } from "@/platform/tauri";

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
  const windowShownRef = useRef(false);

  const showOnboarding = !settingsQuery.data?.onboarding_completed;

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
