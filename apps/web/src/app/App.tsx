import { useEffect, useRef } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "framer-motion";
import { ErrorFallback } from "@/shared/components";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { QueryClientProvider, ThemeProvider } from "./providers";
import { capabilities } from "@/platform";
import { native } from "@/platform";
import { DesktopShell } from "./shells/DesktopShell";
import { webRouter } from "./router";

/**
 * Safety net: ensure the window always becomes visible.
 *
 * The main window starts hidden (show: false in createWindow) to avoid
 * a flash before onboarding/content is ready. Normally the frontend calls
 * show_main_window or enter_onboarding_mode within ~1-2s. But if anything
 * goes wrong (settings fetch hangs, unexpected error, hook crash), the window
 * stays hidden and the user sees only a dock icon with no window.
 *
 * This timeout guarantees the window appears within WINDOW_SHOW_TIMEOUT_MS,
 * no matter what. It's a last resort -- the normal flow or ErrorFallback
 * should show the window sooner.
 */
const WINDOW_SHOW_TIMEOUT_MS = 5_000;

function useWindowShowSafetyNet() {
  const shownRef = useRef(false);
  useEffect(() => {
    if (shownRef.current || !capabilities.windowLifecycle) return;
    const timer = setTimeout(() => {
      if (!shownRef.current) {
        shownRef.current = true;
        console.warn("[App] Safety net: force-showing window after timeout");
        native.window.show().catch(console.error);
      }
    }, WINDOW_SHOW_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
}

function App() {
  // Safety net -- force-show window if nothing else does within 5s
  useWindowShowSafetyNet();

  const content = capabilities.isDesktop ? (
    // Desktop (Electron): no router, direct MainLayout via DesktopShell
    <QueryClientProvider>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary
            FallbackComponent={ErrorFallback}
            onReset={reset}
            onError={createBoundaryErrorHandler("react.error-boundary")}
          >
            <ThemeProvider>
              <DesktopShell reset={reset} />
            </ThemeProvider>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  ) : (
    // Web (browser): TanStack Router with full URL routing
    <QueryClientProvider>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary
            FallbackComponent={ErrorFallback}
            onReset={reset}
            onError={createBoundaryErrorHandler("react.error-boundary")}
          >
            <ThemeProvider>
              <RouterProvider router={webRouter} />
            </ThemeProvider>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );

  return (
    <LazyMotion features={domAnimation} strict>
      {content}
    </LazyMotion>
  );
}

export default App;
