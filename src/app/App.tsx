import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { MainLayout } from "./layouts/MainLayout";
import { ErrorFallback, DashboardError } from "@/shared/components";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { Toaster } from "@/components/ui/sonner";

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
function App() {
  return (
    <QueryClientProvider>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary
            FallbackComponent={ErrorFallback}
            onReset={reset}
            onError={(error, info) => {
              // Log to console in all environments
              console.error("[ErrorBoundary] Caught error:", error);
              console.error("[ErrorBoundary] Component stack:", info.componentStack);

              // TODO: Send to error tracking service in production
              // if (import.meta.env.PROD) {
              //   Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
              // }
            }}
          >
            <ThemeProvider>
              <BrowserRouter>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <ErrorBoundary FallbackComponent={DashboardError} onReset={reset}>
                        <MainLayout />
                      </ErrorBoundary>
                    }
                  />
                </Routes>
              </BrowserRouter>
              <Toaster />
            </ThemeProvider>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );
}

export default App;
