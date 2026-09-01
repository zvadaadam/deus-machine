/**
 * useIsDirectSession — is this session rendered by the direct-agnt lane (Path B)?
 *
 * The ONE source of truth for "direct mode", DERIVED (never threaded), so no
 * message consumer can miss it — including the composer mounted OUTSIDE
 * SessionPanel's tree (FocusModeOverlay, portaled to body). Returns:
 *   - `false`     — flag off, or not a cloud session served direct yet (worktree,
 *                   or a cloud tab whose provider session doesn't exist yet).
 *   - `true`      — a cloud session WITH a provider session to connect to.
 *   - `undefined` — the session row hasn't loaded; callers hold BOTH lanes so an
 *                   unknown beat never clobbers a folded transcript.
 *
 * `isCloudDirectEnabled()` is a stable, non-reactive localStorage read (reload to
 * toggle), so when off this is a constant `false` — a disabled observer, zero
 * fetch, zero behavior change for the flag-off fleet. It observes the SAME
 * `sessions.detail` cache `useSession` already keeps WS-fresh, so it adds an
 * observer, not a fetch.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { SessionService } from "../api/session.service";
import type { Session } from "../types";
import { isCloudDirectEnabled } from "./cloudDirectFlag";

/**
 * The canonical `sessions.detail` query — WS-kept-fresh (`staleTime: Infinity`),
 * HTTP `queryFn` as the initial-load fallback. The one definition every reader
 * spreads (`useSession`, `useWorkingSessionIds`, this hook, the hover prefetch),
 * so there is a single source of truth for how that row is fetched + cached.
 */
export function sessionDetailQueryOptions(sessionId: string) {
  return {
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: () => SessionService.fetchById(sessionId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  } as const;
}

/**
 * Served direct only once there's a provider session to connect to — a brand-new
 * cloud tab renders via the Mac lane until its first send assigns
 * provider_session_id, then flips to direct.
 */
function isDirectRow(session: Session | undefined): boolean {
  return !!session && session.workspace_kind === "cloud" && !!session.provider_session_id;
}

/**
 * Imperative twin of `useIsDirectSession` for callers below hook-space — the
 * send mutation and the hover prefetch, which write the shared message cache and
 * so MUST honor the same lane split (a Mac-lane fetch would clobber a direct
 * fold). Reads the same cached row; an uncached row reads as not-direct.
 */
export function isDirectSessionCached(queryClient: QueryClient, sessionId: string): boolean {
  if (!isCloudDirectEnabled()) return false;
  return isDirectRow(queryClient.getQueryData<Session>(queryKeys.sessions.detail(sessionId)));
}

export function useIsDirectSession(sessionId: string | null): boolean | undefined {
  const flagOn = isCloudDirectEnabled();
  const query = useQuery({
    ...sessionDetailQueryOptions(sessionId || ""),
    enabled: flagOn && !!sessionId,
    select: isDirectRow,
  });
  return flagOn ? query.data : false;
}
