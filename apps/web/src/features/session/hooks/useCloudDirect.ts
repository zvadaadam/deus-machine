/**
 * useCloudDirect — orchestrate the Path B direct-agnt lane for one cloud session.
 *
 * Fetches a session-scoped token from the backend seam (the `cloudDirectToken`
 * `q:` request → `GET /sessions/:id/cloud-direct-token`), then drives
 * `useCloudDirectSession` with it. The folded transcript lands in the same
 * message cache the chat UI reads, so the caller MUST also gate `useMessages`
 * (pass `directMode`) for this session — otherwise the Mac lane's fetch clobbers
 * the fold (see the note in `useCloudDirectSession`).
 */
import { useQuery } from "@tanstack/react-query";
import { sendRequest } from "@/platform/ws";
import { useCloudDirectSession, type CloudDirectStatus } from "./useCloudDirectSession";

interface CloudDirectTokenResponse {
  token: string;
  base_url: string;
  provider_session_id: string;
}

export interface CloudDirectResult {
  /** True once a token is in hand and the direct lane is driving the fold. */
  active: boolean;
  status: CloudDirectStatus;
  error: string | null;
}

export function useCloudDirect(sessionId: string | null, enabled: boolean): CloudDirectResult {
  const tokenQuery = useQuery({
    queryKey: ["cloudDirectToken", sessionId],
    queryFn: () =>
      sendRequest<CloudDirectTokenResponse>("cloudDirectToken", { sessionId: sessionId! }),
    enabled: enabled && !!sessionId,
    // The token lives 60 min; refetch comfortably before it lapses.
    staleTime: 50 * 60 * 1000,
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
