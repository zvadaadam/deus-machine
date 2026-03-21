/**
 * DesktopShell -- Electron desktop mode, no routing.
 *
 * Contains ALL of the existing AppContent gate logic (auth, settings,
 * onboarding, backend error). Renders MainLayout directly without a router.
 *
 * This is the Electron-only code path. Web mode uses TanStack Router instead.
 */

import { useEffect, useRef } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { MainLayout } from "../layouts/MainLayout";
import { DashboardError } from "@/shared/components";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { Toaster } from "@/components/ui/sonner";
import { OnboardingOverlay } from "@/features/onboarding";
import { useSettings } from "@/features/settings";
import { useAuth, PairGatePage } from "@/features/auth";
import { native, capabilities } from "@/platform";
import { initNotifications } from "@/platform/notifications";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import { useWorkspaceInitEvents } from "@/features/workspace/hooks/useWorkspaceInitEvents";
import { useQueryProtocol } from "@/shared/hooks/useQueryProtocol";
import { useBackendRestart } from "@/shared/hooks/useBackendRestart";
import { useAutoUpdate, useUpdateToast, UpdateProvider } from "@/features/updates";
import { useAnalyticsConsent } from "@/platform/analytics";
export function DesktopShell({ reset }: { reset: () => void }) {
  const auth = useAuth();
  const settingsQuery = useSettings();
  const windowShownRef = useRef(false);

  // Request OS notification permission once on mount
  useEffect(() => {
    initNotifications();
  }, []);

  // Global listener: fire OS notifications for ALL session events when backgrounded
  useGlobalSessionNotifications();

  // Global listener: workspace init progress -> invalidate queries on completion
  useWorkspaceInitEvents();

  // Global listener: WS query protocol -> direct cache updates + invalidation dispatch
  useQueryProtocol();

  // Global listener: backend restart -> update cached port + force WS reconnect
  useBackendRestart();

  // Sync PostHog opt-in/out state with analytics_enabled setting
  useAnalyticsConsent();

  // Auto-update: check on launch + every 5 min, show toast when ready
  const autoUpdate = useAutoUpdate();
  useUpdateToast(autoUpdate);

  const showOnboarding = !settingsQuery.isError && !settingsQuery.data?.onboarding_completed;

  // Boot diagnostics -- trace the window-show flow so we can see what's blocking
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.log("[DesktopShell] mount -- auth:", {
        isLoading: auth.isLoading,
        isAuthenticated: auth.isAuthenticated,
      });
      console.log("[DesktopShell] mount -- settings:", {
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
  useEffect(() => {
    if (settingsQuery.isLoading) return;
    if (showOnboarding) {
      windowShownRef.current = false;
      return;
    }
    if (windowShownRef.current) return;
    native.window.show().catch(console.error);
    windowShownRef.current = true;
  }, [settingsQuery.isLoading, showOnboarding]);

  // Remote browser auth gate: show pairing page if not authenticated
  if (auth.isLoading) return null;
  if (!auth.isAuthenticated) return <PairGatePage onPaired={auth.onPaired} />;

  // While settings load, render nothing -- window is hidden anyway
  if (settingsQuery.isLoading) return null;

  // Backend unreachable -- show error instead of white screen
  if (settingsQuery.isError && !settingsQuery.data) {
    return (
      <div className="bg-background flex h-screen items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-foreground text-xl font-semibold">Cannot connect to backend</h1>
          <p className="text-muted-foreground text-sm">
            {capabilities.windowLifecycle
              ? "The backend server failed to start. Check the terminal for errors."
              : "Run `bun run dev:web` for browser development, or use the Electron desktop app (`bun run dev`)."}
          </p>
          <button
            type="button"
            onClick={() => settingsQuery.refetch()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-4 py-2 text-sm font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (showOnboarding) {
    return <OnboardingOverlay />;
  }

  return (
    <UpdateProvider value={autoUpdate}>
      <ErrorBoundary
        FallbackComponent={DashboardError}
        onReset={reset}
        onError={createBoundaryErrorHandler("react.error-boundary.root")}
      >
        <MainLayout />
      </ErrorBoundary>
      <Toaster />
    </UpdateProvider>
  );
}
