import { BrowserRouter, Routes, Route } from "react-router-dom";
import type { ComponentType, ReactNode, ErrorInfo } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { MainLayout } from "./layouts/MainLayout";
import { ErrorFallback, DashboardError } from "@/shared/components";
import { reportError } from "@/shared/utils/errorReporting";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { AuthGate } from "@/features/auth";

/**
 * Root App component with professional error handling setup.
 *
 * Error Boundary Strategy:
 * - QueryErrorResetBoundary: Resets failed TanStack Query queries on retry
 * - Outer ErrorBoundary: Catches any app-level crashes (routing, providers, etc.)
 * - Inner ErrorBoundary: Dashboard-specific errors with custom fallback
 *
 * The onReset callback clears failed queries so "Try Again" actually retries
 * data fetching, not just re-renders with cached error state.
 */
type ConditionalErrorBoundaryProps = {
  fallback: ComponentType<FallbackProps>;
  onReset?: () => void;
  onError?: (error: Error, info: ErrorInfo) => void;
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
                extra: { componentStack: info.componentStack },
              });
              if (typeof window !== "undefined") {
                (window as { __APP_LAST_COMPONENT_STACK__?: string }).__APP_LAST_COMPONENT_STACK__ =
                  info.componentStack;
              }

              // TODO: Send to error tracking service in production
              // if (import.meta.env.PROD) {
              //   Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
              // }
            }}
          >
            <ThemeProvider>
              <AuthGate>
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
              </AuthGate>
              <Toaster />
            </ThemeProvider>
          </ConditionalErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );
}

export default App;
