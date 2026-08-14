// features/import/api/import.queries.ts
// Data hooks for importing sessions from other coding agents.

import { useQuery } from "@tanstack/react-query";
import { sendCommand, sendRequest } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import type { ImportableSessionsSnapshot } from "@shared/types/session-import";

const IMPORTABLE_SESSIONS_KEY = ["import", "importable-sessions"] as const;

export function useImportableSessions(enabled: boolean) {
  useQuerySubscription("importable_sessions", {
    queryKey: IMPORTABLE_SESSIONS_KEY,
    params: {},
    enabled,
  });

  return useQuery({
    queryKey: IMPORTABLE_SESSIONS_KEY,
    queryFn: () => sendRequest<ImportableSessionsSnapshot>("importable_sessions", {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export interface ImportSessionAck {
  accepted: boolean;
  error?: string;
  sessionId?: string;
  workspaceId?: string;
  alreadyImported?: boolean;
}

/** Full parse + insert can take a few seconds on 100MB transcripts. */
export async function importExternalSession(
  key: string,
  workspaceId: string
): Promise<ImportSessionAck> {
  return (await sendCommand(
    "importExternalSession",
    { key, workspaceId },
    120_000
  )) as ImportSessionAck;
}
