import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  getStoredToken,
  storeToken,
  onDeviceAuthChange,
  needsRemoteAuth,
} from "@/platform/ws/device-auth";
import {
  clearMachineUnavailable,
  isMachineUnavailable,
  onMachineAvailability,
  readRelayAccount,
  type RelayAccount,
} from "@/platform/ws/relay-access";
import { isRelayMode } from "@/shared/config/backend.config";
export {
  getStoredToken,
  storeToken,
  clearToken,
  signOut,
  needsRemoteAuth,
} from "@/platform/ws/device-auth";

export interface AuthState {
  /** Relay only: the Deus account this browser is signed in to. */
  account: RelayAccount | null;
  /** Relay only: sign in first — the relay serves a computer to its own account. */
  needsAccount: boolean;
  /** Relay only: Deus Cloud has no such computer for this account. */
  machineUnavailable: boolean;
  /** Local credential presence only. The runtime still authenticates with the host. */
  hasDeviceGrant: boolean;
  onPaired: (token: string, deviceName?: string) => void;
  /** Relay only: ask Deus Cloud about this computer again. */
  retryMachine: () => void;
}

function subscribe(callback: () => void): () => void {
  const stopAuth = onDeviceAuthChange(callback);
  const stopAvailability = onMachineAvailability(callback);
  return () => {
    stopAuth();
    stopAvailability();
  };
}

export function useAuth(serverId?: string): AuthState {
  const requiresAuth = needsRemoteAuth();
  const relay = isRelayMode();
  // One primitive snapshot, so React re-renders exactly when any of the three changes.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => {
      const account = relay ? readRelayAccount() : null;
      const grant =
        !requiresAuth || !!getStoredToken(serverId, relay ? account?.accountId : undefined);
      const unavailable =
        !!account && !!serverId && isMachineUnavailable(account.accountId, serverId);
      return JSON.stringify([account?.bearer ?? null, grant, unavailable]);
    },
    () => JSON.stringify([null, !requiresAuth, false])
  );
  const [bearer, hasDeviceGrant, machineUnavailable] = JSON.parse(snapshot) as [
    string | null,
    boolean,
    boolean,
  ];
  const account = useMemo(
    () => (bearer ? readRelayAccount() : null),
    // The bearer identifies the session; re-read its claims only when it changes.

    [bearer]
  );
  const onPaired = useCallback(
    (token: string, deviceName?: string) => {
      storeToken(token, deviceName, serverId, relay ? (account?.accountId ?? null) : undefined);
    },
    [serverId, relay, account]
  );
  const retryMachine = useCallback(() => {
    if (account && serverId) clearMachineUnavailable(account.accountId, serverId);
  }, [account, serverId]);
  return {
    account,
    needsAccount: relay && !account,
    machineUnavailable,
    hasDeviceGrant,
    onPaired,
    retryMachine,
  };
}
