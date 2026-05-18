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
import { native } from "@/platform";
import { ServerOfflinePage } from "@/features/connection";
import { initNotifications } from "@/platform/notifications";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import { useWorkspaceInitEvents } from "@/features/workspace/hooks/useWorkspaceInitEvents";
import { useQueryProtocol } from "@/shared/hooks/useQueryProtocol";
import { useBackendRestart } from "@/shared/hooks/useBackendRestart";
import { useAutoUpdate, useUpdateToast, UpdateProvider } from "@/features/updates";
import { useAnalyticsConsent } from "@/platform/analytics";
import { onEvent } from "@/platform/ws/query-protocol-client";
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { useWorkspaceStore } from "@/features/workspace/store/workspaceStore";
import { uiActions } from "@/shared/stores/uiStore";

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

  // Hosted web browser tabs stream the native Electron <webview>. If the
  // requested tab does not exist yet, the backend asks this desktop renderer
  // over q:event to create it, then waits for BrowserTab's CDP registration.
  useEffect(() => {
    return onEvent((event, data) => {
      if (event === "browser:nativeTabRequested") {
        handleNativeBrowserTabRequest(data);
        return;
      }
      if (event === "browser:nativeTabCloseRequested") {
        handleNativeBrowserTabCloseRequest(data);
      }
    });
  }, []);

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
    return <ServerOfflinePage onRetry={() => settingsQuery.refetch()} variant="desktop" />;
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

function isNativeBrowserTabRequest(
  data: unknown
): data is { tabId: string; workspaceId: string; url: string } {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  return (
    typeof value.tabId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.url === "string"
  );
}

function handleNativeBrowserTabRequest(data: unknown): void {
  if (!isNativeBrowserTabRequest(data)) return;
  uiActions.closeAllModals();
  useWorkspaceStore.getState().selectWorkspace(data.workspaceId);
  workspaceLayoutActions.setActiveContentTab(data.workspaceId, "browser");
  browserWindowActions.requestNewTab(data.workspaceId, data.url, data.tabId, true);
}

function isNativeBrowserTabCloseRequest(
  data: unknown
): data is { tabId: string; workspaceId?: string } {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  return (
    typeof value.tabId === "string" &&
    (value.workspaceId === undefined || typeof value.workspaceId === "string")
  );
}

function handleNativeBrowserTabCloseRequest(data: unknown): void {
  if (!isNativeBrowserTabCloseRequest(data)) return;
  browserWindowActions.requestCloseTabById(data.tabId, data.workspaceId);
}
