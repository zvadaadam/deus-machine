/**
 * Application binding for the currently selected runtime. Operational state lives
 * in RuntimeClient; features can hold an instance to address a particular host.
 * The function exports preserve existing callers while the shell selects scope.
 */
import {
  getDeploymentMode,
  getServerIdFromUrl,
  resolveBackendEndpoints,
} from "@/shared/config/backend.config";
import { queryClient, setActiveQueryClient } from "@/shared/api/queryClient";
import { CLOUD_SESSION_KEY, readRelayAccount } from "./cloud-session";
import { getStoredToken, onDeviceAuthChange, signOut, needsRemoteAuth } from "./device-auth";
import {
  expireRelayAccount,
  fetchRelayTicket,
  markMachineUnavailable,
  relayProtocols,
  RelayTicketError,
} from "./relay-access";
import {
  RuntimeClient,
  RuntimeError,
  type CallArgs,
  type EventCallback,
  type QueryRequestInterceptor,
  type ToolResponseInterceptor,
} from "./runtime-client";
import type { AnyOp, OutputOf } from "@shared/api/op";
export { RuntimeClient, RuntimeError, OpError } from "./runtime-client";
export { runtimeForQueryClient } from "./runtime-client";
export type { QueryRequestInterceptor, ToolResponseInterceptor } from "./runtime-client";

let active: RuntimeClient | undefined;
let selected:
  | { host: string; mode: string; token: string | null; account: string | null }
  | undefined;
let nextGrant = 0;
const runtimeListeners = new Set<() => void>();
const eventListeners = new Set<EventCallback>();
const connectionListeners = new Set<(connected: boolean) => void>();
// These are adapter registrations, not operation/cache state. Each new runtime
// receives the adapter appropriate to its mode; pending work stays on its owner.
let requestAdapter: { mode: string; request: QueryRequestInterceptor } | null = null;
let toolAdapter: ToolResponseInterceptor | null = null;
let stopAuthListener: (() => void) | undefined;

function cloudCredential(): string | null {
  try {
    return sessionStorage.getItem(CLOUD_SESSION_KEY);
  } catch {
    return null;
  }
}

export function selectRuntime(serverId?: string): RuntimeClient {
  const mode = getDeploymentMode();
  const relay = mode === "web-production";
  const host = relay ? (serverId ?? getServerIdFromUrl() ?? "") : mode;
  const deviceAuth = needsRemoteAuth(mode);
  const grantHost = relay ? host : "standalone";
  // Through the relay a runtime belongs to one account: its tickets and grant.
  const relayAccount = relay ? readRelayAccount() : null;
  const account = relay ? (relayAccount?.accountId ?? null) : mode;
  const token = deviceAuth
    ? getStoredToken(grantHost, relay ? account : undefined)
    : mode === "web-direct"
      ? cloudCredential()
      : null;
  if (
    active &&
    !["disposed", "revoked"].includes(active.getState()) &&
    selected?.host === host &&
    selected.mode === mode &&
    selected.token === token &&
    selected.account === account
  )
    return active;

  const firstCache = active ? undefined : queryClient;
  active?.dispose();
  selected = { host, mode, token, account };
  const client = new RuntimeClient(
    { host, account: account ?? "signed-out", grant: `grant-${++nextGrant}` },
    {
      queryClient: firstCache,
      // Capture host, account and credential now. A later route/token change cannot
      // redirect this client's retries or authenticate it with another host's grant.
      open: async () => {
        const { wsUrl } = await resolveBackendEndpoints(relay ? host : undefined, mode);
        if (!relay) return new WebSocket(wsUrl);
        // Without an account nothing can admit this runtime; stop instead of redialing.
        if (!relayAccount) throw new RuntimeError("rejected", "Sign in to reach this computer");
        let ticket: string;
        try {
          // A ticket opens one socket, so every dial asks Deus Cloud for a fresh one.
          ticket = await fetchRelayTicket(relayAccount, host);
        } catch (error) {
          if (!(error instanceof RelayTicketError) || error.kind === "unavailable") throw error;
          // An expired session, a computer the account lacks, or a refusal will not
          // change by redialing.
          if (active === client) {
            if (error.kind === "expired") expireRelayAccount(relayAccount);
            else markMachineUnavailable(relayAccount.accountId, host);
          }
          throw new RuntimeError("rejected", error.message);
        }
        return new WebSocket(wsUrl, relayProtocols(ticket));
      },
      authenticate: deviceAuth
        ? () => {
            if (!token) throw new Error("Device authorization required");
            return { type: relay ? "authenticate" : "initialize", token };
          }
        : undefined,
      onAuthFailure: deviceAuth
        ? () => {
            if (active === client) signOut(grantHost, relay ? account : undefined);
          }
        : undefined,
      request: requestAdapter?.mode === mode ? requestAdapter.request : undefined,
      toolResponse: toolAdapter ?? undefined,
    }
  );
  active = client;
  setActiveQueryClient(client.queryClient);
  client.onEvent((event, data) => {
    for (const callback of eventListeners) {
      try {
        callback(event, data);
      } catch (error) {
        console.error("[WS] Event listener failed:", error);
      }
    }
  });
  client.onConnectionChange((connected) => {
    for (const callback of connectionListeners) {
      try {
        callback(connected);
      } catch (error) {
        console.error("[WS] Connection listener failed:", error);
      }
    }
  });
  stopAuthListener ??= onDeviceAuthChange(() => {
    if (selected) selectRuntime(selected.host);
  });
  for (const callback of runtimeListeners) callback();
  return client;
}

export function getRuntimeClient(): RuntimeClient {
  return active ?? selectRuntime();
}
export function onRuntimeChange(callback: () => void): () => void {
  runtimeListeners.add(callback);
  return () => {
    runtimeListeners.delete(callback);
  };
}

export const connect = (serverId?: string): Promise<void> =>
  (serverId === undefined ? getRuntimeClient() : selectRuntime(serverId)).connect();
export const isConnected = (): boolean => getRuntimeClient().isConnected();
/** Run an operation from `shared/api` on the selected host. See `RuntimeClient.call`. */
export function call<O extends AnyOp>(op: O, ...args: CallArgs<O>): Promise<OutputOf<O>> {
  return getRuntimeClient().call(op, ...args);
}
export const sendToolResponse: RuntimeClient["sendToolResponse"] = (...args) =>
  getRuntimeClient().sendToolResponse(...args);
export const forceReconnect = (): void => getRuntimeClient().forceReconnect();
export const emitLocalEvent: RuntimeClient["emitLocalEvent"] = (...args) =>
  getRuntimeClient().emitLocalEvent(...args);

/** App-wide notifications follow the selected runtime; domain hooks use its instance. */
export function onEvent(callback: EventCallback): () => void {
  eventListeners.add(callback);
  return () => {
    eventListeners.delete(callback);
  };
}
export function onConnectionChange(callback: (connected: boolean) => void): () => void {
  connectionListeners.add(callback);
  return () => {
    connectionListeners.delete(callback);
  };
}
export function setQueryRequestInterceptor(request: QueryRequestInterceptor | null): void {
  requestAdapter = request ? { mode: getDeploymentMode(), request } : null;
  getRuntimeClient().setQueryRequestInterceptor(request);
}
export function setToolResponseInterceptor(response: ToolResponseInterceptor | null): void {
  toolAdapter = response;
  active?.setToolResponseInterceptor(response);
}

if (import.meta.hot) {
  // Component edits keep the connection; a transport replacement reloads all
  // consumers together so no old facade can continue using a disconnected owner.
  import.meta.hot.accept(() => window.location.reload());
  import.meta.hot.dispose(() => {
    active?.dispose();
    stopAuthListener?.();
  });
}
