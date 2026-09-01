/**
 * useCloudDirect — orchestrate the Path B direct-agnt lane for one cloud session.
 *
 * Fetches a session-scoped token from the backend seam (the `cloudDirectToken`
 * `q:` request → `GET /sessions/:id/cloud-direct-token`), then drives
 * `useCloudDirectSession` with it. The folded transcript lands in the same
 * message cache the chat UI reads; `useMessages` stands its Mac lanes down for a
 * direct session on its own (via `useIsDirectSession`), so the two never race for
 * the key — see the LANE GATING note in `useCloudDirectSession`.
 */
import { useQuery } from "@tanstack/react-query";
import { resolveCloudDirectToken } from "../cloud/cloudDirectToken";
import { useCloudDirectSession, type CloudDirectStatus } from "./useCloudDirectSession";

/** Re-mint at this fraction of the token's lifetime, before the socket dies on a stale one. */
const REMINT_AT_FRACTION = 0.8;
const DEFAULT_TOKEN_LIFETIME_SEC = 3600;

const tokenLifetimeMs = (expiresInSec: number | undefined): number =>
  (expiresInSec ?? DEFAULT_TOKEN_LIFETIME_SEC) * 1000;

export interface CloudDirectResult {
  /** True once a token is in hand and the direct lane is driving the fold. */
  active: boolean;
  status: CloudDirectStatus;
  error: string | null;
}

export function useCloudDirect(
  sessionId: string | null,
  enabled: boolean,
  providerSessionId: string | null
): CloudDirectResult {
  const tokenQuery = useQuery({
    // The token source (backend seam vs WorkOS mint) is chosen inside
    // `resolveCloudDirectToken` — same key + shape either way, so the lane below
    // is source-agnostic. `providerSessionId` feeds the WorkOS paths (the backend
    // seam maps it itself); it's in the key so a session that gains its provider
    // id re-mints.
    queryKey: ["cloudDirectToken", sessionId, providerSessionId],
    queryFn: () => resolveCloudDirectToken(sessionId!, providerSessionId),
    enabled: enabled && !!sessionId,
    // A credential refresh, not a data poll: re-mint at 80% of the token's server
    // lifetime. staleTime is that duration (TanStack anchors it to issuance), and
    // refetchInterval fires the actual re-mint at issuance + 80% — ANCHORED to
    // `dataUpdatedAt`, so a panel remount with a still-fresh cached token re-mints
    // on time instead of resetting the clock. Re-fetching updates dataUpdatedAt,
    // which re-arms the next interval.
    staleTime: (query) => tokenLifetimeMs(query.state.data?.expires_in) * REMINT_AT_FRACTION,
    refetchInterval: (query) => {
      if (!query.state.data) return false;
      const fireAt =
        query.state.dataUpdatedAt +
        tokenLifetimeMs(query.state.data.expires_in) * REMINT_AT_FRACTION;
      return Math.max(fireAt - Date.now(), 1000);
    },
    retry: 1,
  });

  const conn = tokenQuery.data;
  const direct = useCloudDirectSession(
    enabled && sessionId && conn
      ? {
          sessionId,
          providerSessionId: conn.provider_session_id,
          baseUrl: conn.base_url,
          token: conn.token,
        }
      : null
  );

  const tokenError = tokenQuery.error instanceof Error ? tokenQuery.error.message : null;
  return {
    active: enabled && !!conn,
    status: direct.status,
    error: direct.error ?? tokenError,
  };
}
