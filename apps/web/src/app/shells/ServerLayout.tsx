/**
 * ServerLayout -- web mode shell for a connected server.
 *
 * Wraps routes under /s/$serverId. Handles:
 * - Auth gate: shows PairGatePage for unauthenticated relay clients
 * - Relay WebSocket connection with serverId for endpoint resolution
 * - Connection state UI (connecting, offline, reconnecting)
 *
 * The auth gate renders BEFORE the WS connect hooks fire so we don't
 * attempt a tokenless relay connection that would immediately fail.
 */

import { useEffect } from "react";
import { Outlet, useParams } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { initNotifications } from "@/platform/notifications";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import { useWorkspaceInitEvents } from "@/features/workspace/hooks/useWorkspaceInitEvents";
import { useQueryProtocol } from "@/shared/hooks/useQueryProtocol";
import { useBackendRestart } from "@/shared/hooks/useBackendRestart";
import { useAnalyticsConsent } from "@/platform/analytics";
import { useSettings } from "@/features/settings";
import { useAuth, PairGatePage } from "@/features/auth";
import { ServerOfflinePage } from "@/features/connection";
import { isRelayMode } from "@/shared/config/backend.config";

export function ServerLayout() {
  // Extract serverId from route params for relay WS connection
  const { serverId } = useParams({ strict: false }) as { serverId: string };

  // Auth gate: relay mode requires device token authentication.
  // This must be checked BEFORE mounting ServerContent, because
  // ServerContent's useQueryProtocol will attempt a WS connect that
  // requires a valid device token in relay mode.
  const auth = useAuth();
  const relay = isRelayMode();

  // Request OS notification permission once on mount
  useEffect(() => {
    initNotifications();
  }, []);

  // Auth gate for relay mode: show pairing page if not authenticated
  if (relay) {
    if (auth.isLoading) {
      return (
        <div className="bg-background flex h-screen items-center justify-center">
          <div className="text-muted-foreground text-sm">Checking authentication...</div>
        </div>
      );
    }
    if (!auth.isAuthenticated) {
      return <PairGatePage onPaired={auth.onPaired} serverId={serverId} />;
    }
  }

  // Auth passed (or not needed) — mount the connected content.
  // ServerContent is a separate component so its hooks only run
  // after the auth gate passes (hooks can't be conditional).
  return <ServerContent serverId={serverId} />;
}

/**
 * Inner component that runs all the WS + data hooks.
 * Only mounted after the auth gate passes, ensuring we have
 * a valid device token before attempting the relay WS connection.
 */
function ServerContent({ serverId }: { serverId: string }) {
  const settingsQuery = useSettings();

  // Global listeners -- same as DesktopShell
  useGlobalSessionNotifications();
  useWorkspaceInitEvents();

  // Pass serverId so the WS URL resolves to the correct relay endpoint
  useQueryProtocol(serverId);

  useBackendRestart();
  useAnalyticsConsent();

  // While settings load, show a loading state
  if (settingsQuery.isLoading) {
    return (
      <div className="bg-background flex h-screen items-center justify-center">
        <div className="text-muted-foreground text-sm">Connecting...</div>
      </div>
    );
  }

  // Backend unreachable
  if (settingsQuery.isError && !settingsQuery.data) {
    return (
      <ServerOfflinePage
        onRetry={() => settingsQuery.refetch()}
        variant={isRelayMode() ? "relay" : "desktop"}
      />
    );
  }

  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}
