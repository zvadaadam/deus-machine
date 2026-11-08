/**
 * ServerLayout -- web mode shell for a connected server.
 *
 * Wraps routes under /s/$serverId. Handles:
 * - Relay gates: sign in to the computer's Deus account, then approve this
 *   device once (PairGatePage); an approved device reconnects on its own
 * - Relay WebSocket connection with serverId for endpoint resolution
 * - Connection state UI (connecting, offline, reconnecting)
 *
 * The auth gate renders BEFORE the WS connect hooks fire so we don't
 * attempt a tokenless relay connection that would immediately fail.
 */

import { useEffect, useLayoutEffect } from "react";
import { Outlet, useParams } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { initNotifications } from "@/platform/notifications";
import { useGlobalSessionNotifications } from "@/features/session/hooks/useGlobalSessionNotifications";
import { useAgentEvents } from "@/features/session/hooks/useAgentEvents";
import { useWorkspaceInitEvents } from "@/features/workspace/hooks/useWorkspaceInitEvents";
import { useQueryProtocol } from "@/shared/hooks/useQueryProtocol";
import { useBackendRestart } from "@/shared/hooks/useBackendRestart";
import { useAnalyticsConsent } from "@/platform/analytics";
import { useSettings } from "@/features/settings";
import {
  useAuth,
  useMachineMembership,
  PairGatePage,
  RelaySignInPage,
  MachineUnavailablePage,
} from "@/features/auth";
import { ServerOfflinePage } from "@/features/connection";
import { getDeploymentMode, isRelayMode } from "@/shared/config/backend.config";
import { getRuntimeClient, selectRuntime } from "@/platform/ws/query-protocol-client";
import { discardPairCode } from "@/features/auth/lib/pairing-link";
import { markReturningUser } from "@/shared/lib/returningUser";

export function ServerLayout() {
  // Extract serverId from route params for relay WS connection
  const { serverId } = useParams({ strict: false }) as { serverId: string };

  // Auth gate: relay mode requires device token authentication.
  // This must be checked BEFORE mounting ServerContent, because
  // ServerContent's useQueryProtocol will attempt a WS connect that
  // requires a valid device token in relay mode.
  const relay = isRelayMode();
  const auth = useAuth(relay ? serverId : undefined);
  const mode = getDeploymentMode();
  const runtime = getRuntimeClient();
  const { status: membership, machine } = useMachineMembership(
    auth.account,
    serverId,
    relay && !auth.hasDeviceGrant && !auth.machineUnavailable
  );
  useLayoutEffect(() => {
    selectRuntime(serverId);
  }, [serverId, mode]);

  // Request OS notification permission once on mount
  useEffect(() => {
    initNotifications();
  }, []);

  // A pairing link's one-use code is spent only by the approval page. When this
  // browser needs no approval, drop the code from the address bar and history.
  useEffect(() => {
    if (relay && (auth.hasDeviceGrant || auth.machineUnavailable)) discardPairCode(serverId);
  }, [relay, auth.hasDeviceGrant, auth.machineUnavailable, serverId]);

  // Route preloading must never change the active host. Select only after this
  // layout commits, and hold data consumers until its cache belongs to that host.
  if (runtime.identity.host !== (relay ? serverId : mode)) return null;

  // The relay serves a computer only to its own account.
  if (auth.needsAccount) return <RelaySignInPage serverId={serverId} />;
  if (auth.machineUnavailable) {
    return (
      <MachineUnavailablePage
        onRetry={() => {
          auth.retryMachine();
          // The refused runtime stopped for good; dial again with a fresh one.
          selectRuntime(serverId);
        }}
      />
    );
  }

  // Gate both relay and direct remote browsers before mounting data consumers.
  if (!auth.hasDeviceGrant) {
    if (membership === "checking") return null;
    return (
      <PairGatePage
        key={`${auth.account?.accountId ?? "device"}:${serverId}`}
        onPaired={auth.onPaired}
        serverId={serverId}
        account={auth.account}
        machine={machine}
      />
    );
  }

  // Auth passed (or not needed) — mount the connected content.
  // ServerContent is a separate component so its hooks only run
  // after the auth gate passes (hooks can't be conditional).
  return <ServerContent />;
}

/**
 * Inner component that runs all the WS + data hooks.
 * Only mounted after the auth gate passes, ensuring we have
 * a stored device grant before attempting the host's authentication handshake.
 */
function ServerContent() {
  const settingsQuery = useSettings();

  // The product shell mounted, so this browser is a user — mark it so the root
  // domain's edge router serves the app (not the landing) at `/` next time.
  // A no-op off the deusmachine.ai domain family.
  useEffect(() => {
    markReturningUser();
  }, []);

  // Global listeners -- same as DesktopShell
  useGlobalSessionNotifications();
  useAgentEvents();
  useWorkspaceInitEvents();

  // The route selected the runtime before mounting any data consumers.
  useQueryProtocol();

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
